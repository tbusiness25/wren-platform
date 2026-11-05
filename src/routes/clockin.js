const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
// b199 — the Roost enrolment helper listens for the next swipe through this handler.
const fobEnrol = require('../lib/fob-enrol');

// ── Telegram helper ──────────────────────────────────────────────────────────
// login-20261023: through the one Telegram sender (src/lib/notifications.js) — same text and format,
// plus its dev/MAIL_DISABLED guard, which this private copy never had.
function sendTelegram(text) { return require('../lib/notifications').sendTelegramNow({ text, parse_mode: null }); }

function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}

function fmtDuration(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── b199: every swipe leaves a door_events row ────────────────────────────────
// An unknown fob used to vanish into a Telegram message and nothing else — nothing
// in Wren to look at, nothing to assign. Now each swipe writes the same 'card' row
// the b195 console already renders, so an unassigned tap is visible and clickable.
// Fire-and-forget on purpose: a failed audit insert must never block a clock-in.
async function logCardSwipe(db, { uid, staffId, doorLabel, known }) {
  try {
    await db.query(
      `INSERT INTO door_events (event_type, staff_id, card_no, reason)
       VALUES ('card', $1, $2, $3)`,
      // b250 — the wording comes from fob-enrol.swipeReason so the Roost keyring can
      // tell a real tap apart from a fob being issued or revoked. Do not inline it.
      [staffId || null, uid, fobEnrol.swipeReason(doorLabel, known)]
    );
  } catch (e) {
    console.error('[clockin] door_events card row failed:', e.message);
  }
}

// ── b310 (2026-09-10): direction comes from the READER, not from guesswork ────
// Toby: "signing in and out is going to be easiest with [fobs] because they have
// to do it to open the entrance gate. But the issue is signing out because there's
// an emergency exit button staff just press."
//
// So the gate is an IN reader and the office is an OUT reader (ladn.clock_devices),
// and the old toggle-on-alternate-taps logic below is kept ONLY for a device
// configured 'both' — a one-reader setting has no better option. The toggle was
// the bug: a second gate tap (back from the bins, back from lunch) clocked people
// OUT while they were stood in the building.
//
// Three other things changed in here and none of them are cosmetic:
//   * the raw fob UID is no longer written to staff_clock_events or into
//     source_raw. A Mifare Classic UID is all you need to clone the card, so the
//     events table carries CLOCKDEV.hashFob(uid) and the audit blob is scrubbed.
//   * a re-presented fob at the same reader inside clock_repeat_tap_seconds is
//     one tap, and writes nothing.
//   * staff_shifts is no longer patched by hand here. CLOCKDAY.recomputeDay()
//     replays the whole day from the events, so lunch comes out of worked time
//     and a later correction takes effect without anything being edited in place.
const CLOCKDEV = require('../lib/clock-devices');
const CLOCKDAY = require('../lib/clock-day');
const PAIR     = require('../lib/clock-pairing');
// b404 — on-read auto sign-out, called from the endpoints below that already
// answer "who is clocked in right now" (never from the webhook above this).
const CLOCKAUTO = require('../lib/clock-autoclose');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

/** The Europe/London calendar day a timestamp falls in. */
const londonDate = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

// ── Core fob event handler (shared by webhook + direct event route) ───────────
async function handleFobEvent({ fob_uid, door_name, event_time, source_raw, device, source }) {
  const db = getPool();
  const uid = (fob_uid || '').toString().toUpperCase().trim();
  const ts = event_time ? new Date(event_time) : new Date();
  const doorLabel = door_name || (device && device.label) || 'Main Entrance';
  const deviceId = (device && device.device_id) || null;
  const fobHash = CLOCKDEV.hashFob(uid);

  // Look up fob
  const { rows: fobRows } = await db.query(
    `SELECT sf.id, sf.staff_id, sf.label,
            s.first_name, s.last_name, s.role
     FROM staff_fobs sf
     JOIN staff s ON s.id = sf.staff_id
     WHERE sf.fob_uid = $1 AND sf.is_active = true`,
    [uid]
  );

  if (!fobRows.length) {
    // b310 — the UID is MASKED here. It used to be sent in full to a Telegram
    // group, which is a card credential in a chat log. The full number is still
    // available to a signed-in manager in the Roost entry log, and the b250
    // "listen for the next swipe" flow never needs it typed at all.
    sendTelegram(`⚠️ Unknown fob tapped: ${CLOCKDEV.maskFob(uid)} at ${fmtTime(ts)} — assign it in Roost → Clock In/Out`);
    // b199 — make the tap assignable rather than dropping it:
    //   • door_events row so it shows in the Roost entry log with an "Assign" action
    //   • hand it to the enrolment listener if Toby is stood at the reader arming it
    fobEnrol.capture({ card_no: uid, known: false, door_name: doorLabel });
    await logCardSwipe(db, { uid, staffId: null, doorLabel, known: false });
    return { ok: true, unknown_fob: true, card_no_masked: CLOCKDEV.maskFob(uid) };
  }

  const fob = fobRows[0];
  const staffId = fob.staff_id;
  const name = `${fob.first_name} ${fob.last_name}`;

  // b199 — a known fob is logged and offered to the enrolment listener too. Without
  // this, arming enrol and tapping an already-registered fob looks like a dead reader,
  // when in fact it is the exact card Toby wants to re-assign or re-label.
  fobEnrol.capture({ card_no: uid, known: true, staff_id: staffId, staff_name: name, door_name: doorLabel });
  await logCardSwipe(db, { uid, staffId, doorLabel, known: true });

  const date = londonDate(ts);
  const repeatSecs = await CLOCKDAY.setting(db, 'clock_repeat_tap_seconds', 180);

  // The last LIVE event of that person's day — the basis for a 'both' toggle and
  // for the repeat-tap guard. Reads the _current view, so a superseded or voided
  // event can never decide which way the next tap counts.
  const { rows: lastRows } = await db.query(
    `SELECT id, event_type, event_time, device_id
       FROM staff_clock_events_current
      WHERE staff_id = $1
        AND (event_time AT TIME ZONE 'Europe/London')::date = $2::date
      ORDER BY event_time DESC, id DESC LIMIT 1`,
    [staffId, date]
  );
  const last = lastRows[0];

  // b366 — the PIN board writes to this same table, so "the last event" may be
  // a finger on the tablet thirty seconds ago rather than a tap at a reader.
  // Two consequences, and both of them used to be wrong here:
  //
  //  1. A ONE-READER ('both') setting toggled off whatever was last. Sign in on
  //     the tablet at 08:00, tap the door at 08:00:30, and the toggle read the
  //     PIN clock_in and wrote a clock_out. So the toggle now ignores anything
  //     inside the repeat window and flips the last event OUTSIDE it — the last
  //     thing that was a genuinely separate transition.
  //  2. The duplicate check below matches on device_id, and the PIN board has
  //     none, so it could never see a tablet sign-in as the same arrival. The
  //     cross-source guard further down closes that.
  const crossDup = CLOCKDAY.repeatOf(last, ts, repeatSecs);
  const lastSettled = crossDup ? (await db.query(
    `SELECT event_type FROM staff_clock_events_current
      WHERE staff_id = $1 AND (event_time AT TIME ZONE 'Europe/London')::date = $2::date
        AND event_time < $3::timestamptz - make_interval(secs => $4)
      ORDER BY event_time DESC, id DESC LIMIT 1`,
    [staffId, date, ts, repeatSecs])).rows[0] : last;

  const dir = CLOCKDEV.directionFor(device);
  let eventType;
  if (dir === 'in')       eventType = 'clock_in';
  else if (dir === 'out') eventType = 'clock_out';
  else                    eventType = (lastSettled && lastSettled.event_type === 'clock_in') ? 'clock_out' : 'clock_in';

  // The same transition, captured twice by two different channels: the gate and
  // the tablet, or the tablet and the gate. One arrival, one row. Only a
  // matching direction is suppressed — an 'out' reader seconds after an 'in' is
  // somebody who walked straight back out, which is odd but is not a duplicate.
  if (crossDup && crossDup.event_type === eventType && (crossDup.device_id || null) !== (deviceId || null)) {
    return { ok: true, ignored: 'repeat_tap', cross_source: true, staff_id: staffId, name,
             event_type: eventType, duplicate_of: crossDup.id, within_seconds: repeatSecs,
             recorded_by: CLOCKDAY.sourceLabel(crossDup.source) };
  }

  // A fob re-presented at the same reader seconds later is one tap. Write nothing:
  // an employment record should not carry rows that mean nothing happened.
  //
  // Compares against the NEAREST same-direction tap at the SAME reader, not against
  // whichever event is last on the day. Taps normally arrive in time order, but a
  // relayed or backdated tap (dahua-poll.js catching up after an outage) does not,
  // and "is this a duplicate of the most recent row" would then answer no.
  const { rows: nearRows } = await db.query(
    `SELECT id, event_time FROM staff_clock_events_current
      WHERE staff_id = $1 AND event_type = $2
        AND COALESCE(device_id, '') = COALESCE($3, '')
        AND event_time BETWEEN $4::timestamptz - make_interval(secs => $5)
                           AND $4::timestamptz + make_interval(secs => $5)
      ORDER BY abs(extract(epoch FROM (event_time - $4::timestamptz))) LIMIT 1`,
    [staffId, eventType, deviceId, ts, repeatSecs]
  );
  if (nearRows.length) {
    return { ok: true, ignored: 'repeat_tap', staff_id: staffId, name, event_type: eventType,
             duplicate_of: nearRows[0].id, within_seconds: repeatSecs };
  }

  const captureSource = source || (deviceId ? `fob:${deviceId}` : 'fob_reader');

  // Record clock event. fob_uid is deliberately left NULL — the hash identifies
  // the card for every question anyone needs to answer ("was this the same fob?")
  // without storing the credential a second time.
  const { rows: ins } = await db.query(
    `INSERT INTO staff_clock_events
       (staff_id, event_type, method, fob_hash, device_id, door_name, event_time, source, source_raw)
     VALUES ($1, $2, 'fob', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [staffId, eventType, fobHash, deviceId, doorLabel, ts, captureSource,
     JSON.stringify(CLOCKDEV.scrubRaw(source_raw || {}))]
  );

  // One derivation, from the events, for the whole day.
  const day = await CLOCKDAY.recomputeDay(db, staffId, date);

  if (eventType === 'clock_in') {
    sendTelegram(`👤 ${name} clocked IN — ${fmtTime(ts)} (${doorLabel})`);
  } else {
    const worked = day.workedMinutes ? ` · worked ${PAIR.fmtMinutes(day.workedMinutes)}` : '';
    const brk = day.breakMinutes ? ` (break ${PAIR.fmtMinutes(day.breakMinutes)})` : '';
    sendTelegram(`👋 ${name} clocked OUT — ${fmtTime(ts)}${worked}${brk}`);
  }

  return {
    ok: true, staff_id: staffId, name, event_type: eventType, event_id: ins[0].id,
    device: deviceId, direction: dir, date,
    worked_minutes: day.workedMinutes, break_minutes: day.breakMinutes,
    open: !!day.open,
    // Kept for callers that read the old field name.
    total_minutes: day.workedMinutes,
  };
}

// ── Public: door intercom webhook (no auth — Dahua can't send JWT) ────────────────
// Must be before authenticate middleware
router.use(express.text({ type: 'text/xml' }));
router.use(express.text({ type: 'application/xml' }));

// If DAHUA_WEBHOOK_SECRET is set, validate x-webhook-secret header
const DAHUA_SECRET = process.env.DAHUA_WEBHOOK_SECRET;

// b310 — ONE webhook, as the brief requires. What changed is what it demands
// before it will write anything:
//   * the tap must resolve to an ACTIVE row in ladn.clock_devices (by device id,
//     by door-name alias, or by source IP). No match ⇒ 403 and nothing written.
//     This endpoint is public and unauthenticated; "anything that can reach the
//     port may write a timesheet" is not a posture we can defend.
//   * hard rate limits per device, per unknown IP, and globally.
// Note the deliberate change in reply code: the old handler answered 200 to
// everything so the VTO would stop retrying. A REFUSAL is not an error and must
// be visible — a reader silently 200-ing while recording nothing is how you find
// out in April that March has no timesheets.
router.post('/dahua-webhook', async (req, res) => {
  if (DAHUA_SECRET && req.headers['x-webhook-secret'] !== DAHUA_SECRET) {
    return res.status(403).end();
  }
  try {
    let body = req.body;
    // If body is a string (XML), try to parse card UID from it
    if (typeof body === 'string') {
      const raw = body;
      const match = raw.match(/<CardNo>([^<]+)<\/CardNo>|cardno["\s:=]+([A-Fa-f0-9]+)/i);
      const doorM = raw.match(/<DoorName>([^<]+)<\/DoorName>/i);
      const snM   = raw.match(/<(?:SN|DeviceID|SerialNumber)>([^<]+)<\/(?:SN|DeviceID|SerialNumber)>/i);
      if (!match) return res.status(200).send('OK');
      body = { CardNo: match[1] || match[2] };
      if (doorM) body.DoorName = doorM[1];
      if (snM)   body.device_id = snM[1];
    }
    if (!body || typeof body !== 'object') return res.status(200).send('OK');

    const ip = CLOCKDEV.clientIp(req);
    const claimedId = CLOCKDEV.deviceIdFrom(body) || CLOCKDEV.doorNameFrom(body);

    const rl = CLOCKDEV.rateLimit({ deviceId: claimedId, ip });
    if (!rl.ok) {
      CLOCKDEV.noteRefusal({ reason: 'rate_limited', scope: rl.scope, device_id: claimedId, ip });
      return res.status(429).json({ error: 'Rate limited', scope: rl.scope });
    }

    const db = getPool();
    const { device, matched_on, tried, reason } = await CLOCKDEV.resolve(db, body, req);
    if (!device) {
      // No staff identity is known at this point and none is looked up — a tap
      // from an unrecognised reader is refused before the fob is ever resolved.
      CLOCKDEV.noteRefusal({ reason: reason || 'unknown_device', device_id: tried.device_id, door_name: tried.door_name, ip: tried.ip });
      console.warn('[clockin] refused tap from unknown reader:', JSON.stringify(tried));
      return res.status(403).json({
        error: 'Unknown clock device',
        tried,
        fix: 'Add this reader in Roost → Clock In/Out → Readers, then tap again.'
      });
    }

    // Stamp the reader as soon as it is RECOGNISED, before the fob is looked up.
    // last_seen_at answers "is the reader talking to Wren at all", and the moment
    // you most need that answer is while tapping a card that is not registered yet.
    // Fire-and-forget: a diagnostics column must never fail a clock-in.
    db.query('UPDATE clock_devices SET last_seen_at = now() WHERE id = $1', [device.id])
      .catch(e => console.error('[clockin] last_seen_at:', e.message));

    const fob_uid = body.CardNo || body.card_no || body.cardNumber ||
                    body.RFID || (body.AccessControlCard && body.AccessControlCard.CardNo);
    if (!fob_uid) return res.status(200).send('OK');

    const result = await handleFobEvent({
      fob_uid: fob_uid.toString().toUpperCase().trim(),
      door_name: CLOCKDEV.doorNameFrom(body) || device.label,
      event_time: body.Time || body.time || new Date().toISOString(),
      source_raw: { ...body, _matched_on: matched_on },
      device,
    });
    // The reply carries no card number and no raw UID, by construction.
    res.status(200).json({ ok: true, device: device.device_id, direction: device.direction, result });
  } catch (e) {
    console.error('Dahua webhook error:', e.message);
    res.status(200).send('OK'); // an internal fault still answers the reader
  }
});

// ── On-site guard for public clock-in board ───────────────────────────────
// H4 fix (2026-06-20): GET /today must not dump the staff roster to an off-site caller.
// Allow if a valid JWT is present OR the request is on-site (nursery WAN IP or RFC1918).
const _clockinNurseryIp = process.env.NURSERY_PUBLIC_IP;
function _clockinIsOnSite(req) {
  const ip = (req.headers['cf-connecting-ip'] || '').trim()
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.ip || '').replace('::ffff:', '').trim();
  if (!ip) return false;
  if (ip === _clockinNurseryIp) return true;
  if (/^127\./.test(ip) || ip === '::1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  const m = ip.match(/^100\.(\d+)\./);
  if (m && +m[1] >= 64 && +m[1] <= 127) return true;
  return false;
}

// ── Public: GET /today — all active staff clock status (kiosk board) ─────
// H4: gated — allow JWT or on-site, else 403
router.get('/today', async (req, res) => {
  const hasJwt = !!(req.headers['authorization'] || '').startsWith('Bearer ');
  const tok = (req.headers['authorization'] || '').slice(7) || (req.headers['x-wren-token'] || '');
  let jwtOk = false;
  if (hasJwt) {
    try {
      const { verify } = require('jsonwebtoken');
      const d = verify(tok, process.env.JWT_SECRET);
      if (d && Number(d.id) > 0) jwtOk = true;
    } catch {}
  }
  if (!jwtOk && !_clockinIsOnSite(req)) {
    return res.status(403).json({ error: 'Clock-in board is only available on the nursery network or with staff login.' });
  }
  try {
    const db = getPool();
    // b404 — this board is exactly the "any endpoint that lists currently
    // clocked-in staff" the brief names as an on-read trigger. Fire-and-forget:
    // a sweep failure must never stop the kiosk board from loading.
    try { await CLOCKAUTO.autoCloseOverdueShifts(db); }
    catch (e) { console.error('[clockin/today] autoclose sweep:', e.message); }
    const { rows } = await db.query(`
      SELECT
        s.id as staff_id,
        s.first_name || ' ' || s.last_name as name,
        s.role,
        r.name as room,
        ss.clock_in_time,
        ss.clock_out_time,
        ss.total_minutes,
        ss.status as shift_status,
        CASE
          WHEN ss.clock_in_time IS NOT NULL AND ss.clock_out_time IS NULL THEN 'in'
          WHEN ss.clock_out_time IS NOT NULL THEN 'out'
          ELSE 'not_arrived'
        END as status,
        CASE
          WHEN ss.clock_in_time IS NOT NULL AND ss.clock_out_time IS NULL
          THEN ROUND(EXTRACT(EPOCH FROM (NOW() - ss.clock_in_time))/3600, 2)
          WHEN ss.total_minutes IS NOT NULL
          THEN ROUND(ss.total_minutes::numeric/60, 2)
          ELSE NULL
        END as hours_today,
        EXISTS(
          SELECT 1 FROM staff_fobs sf
          WHERE sf.staff_id = s.id AND sf.is_active = true
        ) as fob_registered
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      LEFT JOIN staff_shifts ss ON ss.staff_id = s.id AND ss.shift_date = CURRENT_DATE
      WHERE s.is_active = true
      ORDER BY
        CASE WHEN ss.clock_in_time IS NOT NULL AND ss.clock_out_time IS NULL THEN 0
             WHEN ss.clock_out_time IS NOT NULL THEN 1
             ELSE 2
        END,
        s.first_name
    `);
    res.json(rows);
  } catch (e) {
    if (e.code === '42P01') {
      return res.json({ shifts: [], message: 'Clock-in data not available in demo' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── Auth middleware — all routes below require valid JWT ──────────────────────
router.use(authenticate);

// ── POST /event — internal event (called by polling script or n8n) ────────────
// b310 — this one is authenticated, so it is not the public-surface risk the
// webhook is. It still resolves a device where it can, because otherwise a tap
// relayed by dahua-poll.js would come through with no direction and fall back to
// the toggle the build exists to remove. An explicit `direction` is accepted for
// a relay that knows better than the payload does.
router.post('/event', async (req, res) => {
  // 29 Oct: from the HR portal (staff's own phones) any signed-in member of staff could clock a
  // colleague in or out, at any time, with their fob number. The relays don't call this through
  // hr.*; on that portal it is managers only.
  if (req._portal === 'hr' && !hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Managers only' });
  }
  const { fob_uid, door_name, event_time, raw_payload, device_id, direction } = req.body;
  if (!fob_uid) return res.status(400).json({ error: 'fob_uid required' });
  try {
    const db = getPool();
    const { device } = await CLOCKDEV.resolve(db, { ...(raw_payload || {}), device_id, DoorName: door_name }, req);
    const dev = device || (direction ? { device_id: device_id || null, label: door_name || null, direction } : null);
    const result = await handleFobEvent({
      fob_uid, door_name, event_time, source_raw: raw_payload, device: dev,
      source: dev ? undefined : 'fob_relay_no_device',
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /manual — manager manual clock in/out ────────────────────────────────
// b310 — unchanged in who may call it and what it means; changed in what it
// leaves behind. The event now says a manager recorded it and which manager, and
// the shift row is derived from the events rather than patched here, so a manual
// clock-out at 17:00 on a day with a lunch pair produces worked time that
// excludes the lunch instead of a straight first-to-last span.
// `at` (HH:MM) may be supplied to record a time other than now — the common case
// is a manager catching up the morning after.
router.post('/manual', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager only' });
  }
  const { staff_id, event_type, notes, at, on } = req.body;
  if (!staff_id || !['clock_in','clock_out'].includes(event_type)) {
    return res.status(400).json({ error: 'staff_id and event_type (clock_in|clock_out) required' });
  }
  if (at && !CLOCKDAY.isTime(at)) return res.status(400).json({ error: 'at must be HH:MM' });
  if (on && !CLOCKDAY.isDate(on)) return res.status(400).json({ error: 'on must be YYYY-MM-DD' });
  try {
    const db = getPool();
    const { rows: staffRows } = await db.query(
      'SELECT id, first_name, last_name FROM staff WHERE id=$1 AND is_active=true', [staff_id]
    );
    if (!staffRows.length) return res.status(404).json({ error: 'Staff not found' });
    const s = staffRows[0];
    const date = on || CLOCKDAY.londonToday();

    const { rows: ins } = await db.query(
      at
        ? `INSERT INTO staff_clock_events (staff_id, event_type, method, event_time, source, recorded_by, source_raw)
           VALUES ($1, $2, 'manual', ($5::text || ' ' || $6::text)::timestamp AT TIME ZONE 'Europe/London',
                   'manager_entered', $4, $3) RETURNING id, event_time`
        : `INSERT INTO staff_clock_events (staff_id, event_type, method, event_time, source, recorded_by, source_raw)
           VALUES ($1, $2, 'manual', now(), 'manager_entered', $4, $3) RETURNING id, event_time`,
      at ? [staff_id, event_type, JSON.stringify({ notes: notes || null, manager_id: req.user.id }), req.user.id, date, at]
         : [staff_id, event_type, JSON.stringify({ notes: notes || null, manager_id: req.user.id }), req.user.id]
    );
    const ts = new Date(ins[0].event_time);

    if (notes) {
      await db.query(
        `INSERT INTO staff_shifts (staff_id, shift_date, notes) VALUES ($1, $2::date, $3)
         ON CONFLICT (staff_id, shift_date) DO UPDATE SET notes = COALESCE(EXCLUDED.notes, staff_shifts.notes)`,
        [staff_id, date, notes]);
    }
    const day = await CLOCKDAY.recomputeDay(db, staff_id, date);

    const name = `${s.first_name} ${s.last_name}`;
    const msg = event_type === 'clock_in'
      ? `👤 ${name} clocked IN (recorded by a manager) — ${fmtTime(ts)}`
      : `👋 ${name} clocked OUT (recorded by a manager) — ${fmtTime(ts)}${day.workedMinutes ? ` · worked ${fmtDuration(day.workedMinutes)}` : ''}`;
    sendTelegram(msg);

    res.json({
      ok: true, event_type, name, event_id: ins[0].id, date,
      worked_minutes: day.workedMinutes, break_minutes: day.breakMinutes,
      total_minutes: day.workedMinutes,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /staff/:staffId/history ───────────────────────────────────────────────
router.get('/staff/:staffId/history', async (req, res) => {
  // Roost's clockin.html (manager report) is the only legitimate caller of another
  // colleague's history — everyone else may only read their own (bughunt 2026-07-21).
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin']) && req.user.id !== Number(req.params.staffId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const days = Math.min(parseInt(req.query.days) || 14, 90);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ss.*,
             s.first_name || ' ' || s.last_name as staff_name
      FROM staff_shifts ss
      JOIN staff s ON s.id = ss.staff_id
      WHERE ss.staff_id = $1
        AND ss.shift_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      ORDER BY ss.shift_date DESC
    `, [req.params.staffId, days]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /fobs — register new fob ─────────────────────────────────────────────
router.post('/fobs', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager only' });
  }
  const { staff_id, fob_uid, label } = req.body;
  if (!staff_id || !fob_uid) return res.status(400).json({ error: 'staff_id and fob_uid required' });
  const uid = fob_uid.toString().toUpperCase().trim();
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO staff_fobs (staff_id, fob_uid, label, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (fob_uid) DO UPDATE SET staff_id=$1, label=$3, is_active=true, deactivated_at=NULL
       RETURNING *`,
      [staff_id, uid, label || null]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /fobs/:id — deactivate fob ────────────────────────────────────────
router.delete('/fobs/:id', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager only' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE staff_fobs SET is_active=false, deactivated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fob not found' });
    res.json({ ok: true, fob: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /fobs — list all fobs with staff name ─────────────────────────────────
router.get('/fobs', async (req, res) => {
  // sec-20261026: every staff token could list every colleague's fob UID (a
  // Mifare Classic UID is cloneable, and POST /event accepts any UID). Same
  // gate as the POST/DELETE fob routes beside it; Roost clockin.html is the
  // only caller.
  if (!['manager','deputy_manager', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sf.id, sf.fob_uid, sf.label, sf.is_active, sf.registered_at, sf.deactivated_at,
             sf.staff_id,
             s.first_name || ' ' || s.last_name as staff_name,
             s.role
      FROM staff_fobs sf
      JOIN staff s ON s.id = sf.staff_id
      ORDER BY sf.is_active DESC, s.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===========================================================================
 * b310 (2026-09-10) — readers, the missing-tap queue, corrections, and the
 * staff-facing view. Everything below sits under the authenticate middleware
 * mounted above; the ONE public surface remains /dahua-webhook.
 * ===========================================================================*/

const B310_MANAGER = ['manager', 'deputy_manager', 'admin'];
const b310IsManager = req => B310_MANAGER.includes(req.user && req.user.role);

// ── Readers ──────────────────────────────────────────────────────────────────
// GET /devices — the mapping that decides which way a tap counts, plus the taps
// that were refused. The refusal list is the setup tool: point the new office
// reader at Wren, tap it, and whatever it called itself appears here to be
// copied into a device row.
router.get('/devices', async (req, res) => {
  if (!b310IsManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT d.*, (SELECT count(*) FROM staff_clock_events e WHERE e.device_id = d.device_id)::int AS event_count
        FROM clock_devices d ORDER BY d.is_active DESC, d.direction, d.label`);
    res.json({
      devices: rows,
      refusals: CLOCKDEV.recentRefusals(),
      limits: CLOCKDEV.LIMITS,
      // Said plainly on the screen, because it is the whole security posture of a
      // public endpoint: a reader Wren has not been told about writes nothing.
      note: 'A tap is only recorded if it resolves to an ACTIVE reader below — by device id, by door-name alias, or by source IP. Anything else is refused.',
    });
  } catch (e) {
    if (e.code === '42P01') return res.json({ devices: [], refusals: [], note: 'clock_devices table not present in this schema.' });
    res.status(500).json({ error: e.message });
  }
});

// POST /devices — add or update a reader. Upsert on device_id so re-saving the
// same reader edits it rather than creating a twin.
router.post('/devices', async (req, res) => {
  if (!b310IsManager(req)) return res.status(403).json({ error: 'Manager only' });
  const b = req.body || {};
  const deviceId = String(b.device_id || '').trim();
  const label = String(b.label || '').trim();
  const direction = String(b.direction || 'both').toLowerCase();
  if (!deviceId || !label) return res.status(400).json({ error: 'device_id and label are required' });
  if (!['in', 'out', 'both'].includes(direction)) return res.status(400).json({ error: "direction must be 'in', 'out' or 'both'" });
  const arr = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
    : String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  try {
    const db = getPool();
    const { rows: existing } = await db.query('SELECT id FROM clock_devices WHERE lower(device_id) = lower($1)', [deviceId]);
    const params = [deviceId, label, direction, b.location || null, b.kind || null,
                    arr(b.aliases), arr(b.ip_allow), b.is_active !== false, b.notes || null];
    const { rows } = existing.length
      ? await db.query(`UPDATE clock_devices SET device_id=$1, label=$2, direction=$3, location=$4,
                          kind=$5, aliases=$6, ip_allow=$7, is_active=$8, notes=$9, updated_at=now()
                        WHERE id=$10 RETURNING *`, [...params, existing[0].id])
      : await db.query(`INSERT INTO clock_devices (device_id, label, direction, location, kind, aliases, ip_allow, is_active, notes)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, params);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── The missing-tap queue ────────────────────────────────────────────────────
// The sweep is run on read rather than on a schedule. There is no cron line for
// b310 on purpose: host scripts under wren/scripts run from the working tree and
// would reach prod the same night, which a DEV-ONLY build must not do. The sweep
// is idempotent, so calling it whenever somebody opens one of these screens costs
// a few queries and is always up to date.
async function b310Sweep(db, staffId) {
  try { return await CLOCKDAY.sweepQueries(db, staffId ? { staffId } : {}); }
  catch (e) { console.error('[clockin/sweep]', e.message); return null; }
}

// GET /queries — open questions. Managers see everybody's; everybody else sees
// their own and nobody else's.
router.get('/queries', async (req, res) => {
  try {
    const db = getPool();
    const mine = !b310IsManager(req) || req.query.scope === 'mine';
    await b310Sweep(db, mine ? req.user.id : null);
    const params = [];
    let where = "q.status = 'open'";
    if (req.query.status && ['open', 'answered', 'dismissed', 'superseded', 'all'].includes(req.query.status)) {
      where = req.query.status === 'all' ? 'true' : `q.status = '${req.query.status}'`;
    }
    if (mine) { params.push(req.user.id); where += ` AND q.staff_id = $${params.length}`; }
    const { rows } = await db.query(`
      SELECT q.*, s.first_name || ' ' || s.last_name AS staff_name,
             q.occurred_on::text AS date,
             -- pg hands a DATE back as a local-midnight JS Date; casting in SQL is the
             -- only version that is right in every timezone.
             -- memory/reference_pg_date_ymd_trap.md
             to_char(q.opened_at AT TIME ZONE 'Europe/London', 'HH24:MI') AS opened_hhmm,
             to_char(q.suggested_time, 'HH24:MI') AS suggested_hhmm,
             to_char(q.scheduled_start, 'HH24:MI') AS scheduled_start_hhmm,
             to_char(q.scheduled_end,   'HH24:MI') AS scheduled_end_hhmm,
             to_char(q.answer_time,     'HH24:MI') AS answer_hhmm
        FROM clock_queries q JOIN staff s ON s.id = q.staff_id
       WHERE ${where}
       ORDER BY q.occurred_on DESC, q.id DESC LIMIT 300`, params);
    res.json({
      queries: rows,
      scope: mine ? 'mine' : 'all',
      // The wording the screens use, kept in one place so it cannot drift into
      // something that sounds like an accusation.
      prompt: 'A tap is missing. What time was it really? The rota time is offered as a starting point and is never recorded unless you choose it.',
    });
  } catch (e) {
    if (e.code === '42P01') return res.json({ queries: [], scope: 'mine' });
    res.status(500).json({ error: e.message });
  }
});

// POST /queries/:id/answer — { time: 'HH:MM', note? }
// A staff member answering for themselves writes source='self_reported'. A
// manager answering for somebody else writes 'manager_reported'. Nobody's answer
// is ever assumed: the route refuses without an explicit time even though the
// screen shows a suggestion.
router.post('/queries/:id/answer', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT staff_id, status FROM clock_queries WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const own = rows[0].staff_id === req.user.id;
    if (!own && !b310IsManager(req)) return res.status(403).json({ error: 'You can only answer your own.' });
    const time = String(req.body?.time || '').trim();
    if (!CLOCKDAY.isTime(time)) {
      return res.status(400).json({ error: 'A time (HH:MM) is required. The rota time is a suggestion on screen; it is never recorded on your behalf.' });
    }
    const out = await CLOCKDAY.answerQuery(db, {
      queryId: Number(req.params.id), time, note: req.body?.note || null,
      byStaffId: req.user.id, source: own ? 'self' : 'manager',
    });
    if (!out.ok) return res.status(409).json(out);
    res.json({ ...out, day: undefined, worked_minutes: out.day.workedMinutes, break_minutes: out.day.breakMinutes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /queries/:id/dismiss — { reason }
// "That day never happened" — the shift was cancelled, they were off, somebody
// else's fob was tapped. Manager only, and the question stays on the record as
// dismissed rather than disappearing.
router.post('/queries/:id/dismiss', async (req, res) => {
  if (!b310IsManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE clock_queries SET status='dismissed', answer_note=$2, answered_by=$3,
             answered_at=now(), updated_at=now()
       WHERE id=$1 AND status='open' RETURNING *`,
      [req.params.id, req.body?.reason || null, req.user.id]);
    if (!rows.length) return res.status(409).json({ error: 'Not an open question' });
    res.json({ ok: true, query: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /reconcile/sweep — run the sweep by hand. Manager only.
router.post('/reconcile/sweep', async (req, res) => {
  if (!b310IsManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const out = await CLOCKDAY.sweepQueries(getPool(), { from: req.body?.from, to: req.body?.to });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Corrections ──────────────────────────────────────────────────────────────
// POST /correct — { event_id, time?: 'HH:MM', void?: true, reason }
//
// NOTHING IS EVER UPDATED. A correction inserts a NEW event that points at the
// one it replaces (corrects_event_id), carrying who did it and why; the view
// ladn.staff_clock_events_current then stops returning the old row. `void: true`
// records that the tap should never have counted at all — a mistap, or somebody
// else's fob — as a 'clock_void' row rather than a deletion.
// This is the shape a pay dispute needs: the original claim, the correction, the
// name against it and the reason, all still there six years later.
router.post('/correct', async (req, res) => {
  if (!b310IsManager(req)) return res.status(403).json({ error: 'Manager only' });
  const b = req.body || {};
  const reason = String(b.reason || '').trim();
  if (!b.event_id) return res.status(400).json({ error: 'event_id required' });
  if (!reason) return res.status(400).json({ error: 'A reason is required — a correction with no reason is not a correction.' });
  if (!b.void && !CLOCKDAY.isTime(b.time)) return res.status(400).json({ error: 'time (HH:MM) required, or void:true' });
  try {
    const db = getPool();
    const { rows: orig } = await db.query(
      `SELECT id, staff_id, event_type, event_time, device_id, fob_hash, method
         FROM staff_clock_events WHERE id = $1`, [b.event_id]);
    if (!orig.length) return res.status(404).json({ error: 'Event not found' });
    const e0 = orig[0];
    const { rows: already } = await db.query('SELECT id FROM staff_clock_events WHERE corrects_event_id = $1', [e0.id]);
    if (already.length) return res.status(409).json({ error: 'That event has already been corrected', by_event_id: already[0].id });

    const date = new Date(e0.event_time).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    // Two shapes, each with its own parameter list and no unused placeholders —
    // pg cannot infer the type of a parameter that never appears in the statement.
    const COLS = `(staff_id, event_type, method, event_time, source, recorded_by,
                   corrects_event_id, correction_reason, fob_hash, device_id)`;
    const { rows: ins } = b.void
      ? await db.query(
          `INSERT INTO staff_clock_events ${COLS}
           VALUES ($1, 'clock_void', $2, $3, 'correction', $4, $5, $6, $7, $8)
           RETURNING id, event_time`,
          [e0.staff_id, e0.method || 'manual', e0.event_time, req.user.id, e0.id, reason, e0.fob_hash, e0.device_id])
      : await db.query(
          `INSERT INTO staff_clock_events ${COLS}
           VALUES ($1, $2, $3, ($4::text || ' ' || $5::text)::timestamp AT TIME ZONE 'Europe/London',
                   'correction', $6, $7, $8, $9, $10)
           RETURNING id, event_time`,
          [e0.staff_id,
           ['clock_in', 'clock_out'].includes(b.event_type) ? b.event_type : e0.event_type,
           e0.method || 'manual', date, b.time,
           req.user.id, e0.id, reason, e0.fob_hash, e0.device_id]);
    const day = await CLOCKDAY.recomputeDay(db, e0.staff_id, date);
    res.json({
      ok: true, corrected_event_id: e0.id, new_event_id: ins[0].id, date,
      voided: !!b.void, worked_minutes: day.workedMinutes, break_minutes: day.breakMinutes,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /day/:staffId/:date — one person, one day, with the working shown ────
// Every live event, every pair, the anomalies, and the superseded rows behind
// them. Managers may read anybody's; everybody else, only their own.
router.get('/day/:staffId/:date', async (req, res) => {
  const staffId = Number(req.params.staffId);
  if (!b310IsManager(req) && req.user.id !== staffId) return res.status(403).json({ error: 'Forbidden' });
  if (!CLOCKDAY.isDate(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const db = getPool();
    const day = await CLOCKDAY.recomputeDay(db, staffId, req.params.date);
    const { rows: events } = await db.query(`
      SELECT e.id, e.event_type, e.event_time, e.method, e.source, e.device_id, e.door_name,
             e.corrects_event_id, e.correction_reason, e.recorded_by, e.query_id,
             -- b404 — so a manager can tell an auto sign-out (closing time /
             -- long gap, nobody tapped) apart from a real tap or manual entry.
             e.is_automatic, e.auto_close_reason,
             to_char(e.event_time AT TIME ZONE 'Europe/London', 'HH24:MI') AS hhmm,
             (SELECT c.id FROM staff_clock_events c WHERE c.corrects_event_id = e.id) AS superseded_by,
             r.first_name || ' ' || r.last_name AS recorded_by_name
        FROM staff_clock_events e
        LEFT JOIN staff r ON r.id = e.recorded_by
       WHERE e.staff_id = $1 AND (e.event_time AT TIME ZONE 'Europe/London')::date = $2::date
       ORDER BY e.event_time ASC, e.id ASC`, [staffId, req.params.date]);
    const rota = await CLOCKDAY.rotaTimes(db, staffId, req.params.date);
    const { rows: queries } = await db.query(
      `SELECT id, kind, status, to_char(suggested_time,'HH24:MI') AS suggested_hhmm,
              to_char(answer_time,'HH24:MI') AS answer_hhmm, answer_source, answer_note
         FROM clock_queries WHERE staff_id=$1 AND occurred_on=$2::date`, [staffId, req.params.date]);
    res.json({
      staff_id: staffId, date: req.params.date, rota, queries,
      // fob_uid is not in this payload and never will be: the events carry a hash.
      events,
      pairs: day.pairs.map(p => ({
        ...p,
        in_hhmm: new Date(p.in_at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }),
        out_hhmm: new Date(p.out_at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }),
      })),
      worked_minutes: day.workedMinutes, break_minutes: day.breakMinutes,
      span_minutes: day.spanMinutes, anomalies: day.anomalies,
      open: !!day.open, complete: day.complete,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /my — the staff-facing view ──────────────────────────────────────────
// Today's taps, this week's hours, and anything waiting for an answer. Reads
// req.user.id only; there is no staff_id parameter, so it cannot be pointed at a
// colleague.
router.get('/my', async (req, res) => {
  try {
    const db = getPool();
    const staffId = req.user.id;
    await b310Sweep(db, staffId);

    const today = CLOCKDAY.londonToday();
    // The Monday of the week `today` falls in.
    const d = new Date(today + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    const weekStart = d.toISOString().slice(0, 10);

    const day = await CLOCKDAY.recomputeDay(db, staffId, today);
    const { rows: todayEvents } = await db.query(`
      SELECT id, event_type, source, device_id, door_name,
             to_char(event_time AT TIME ZONE 'Europe/London', 'HH24:MI') AS hhmm
        FROM staff_clock_events_current
       WHERE staff_id = $1 AND (event_time AT TIME ZONE 'Europe/London')::date = $2::date
       ORDER BY event_time ASC`, [staffId, today]);

    const { rows: week } = await db.query(`
      SELECT shift_date::text AS date, worked_minutes, break_minutes, total_minutes, status,
             to_char(clock_in_time  AT TIME ZONE 'Europe/London', 'HH24:MI') AS in_hhmm,
             to_char(clock_out_time AT TIME ZONE 'Europe/London', 'HH24:MI') AS out_hhmm
        FROM staff_shifts
       WHERE staff_id = $1 AND shift_date BETWEEN $2::date AND $2::date + 6
       ORDER BY shift_date`, [staffId, weekStart]);

    const { rows: queries } = await db.query(`
      SELECT id, occurred_on::text AS date, kind, status,
             to_char(opened_at AT TIME ZONE 'Europe/London','HH24:MI') AS opened_hhmm,
             to_char(suggested_time,'HH24:MI') AS suggested_hhmm,
             to_char(scheduled_start,'HH24:MI') AS scheduled_start_hhmm,
             to_char(scheduled_end,'HH24:MI')   AS scheduled_end_hhmm
        FROM clock_queries
       WHERE staff_id = $1 AND status = 'open'
       ORDER BY occurred_on DESC`, [staffId]);

    const weekWorked = week.reduce((a, r) => a + (Number(r.worked_minutes) || 0), 0);
    const status = day.open ? 'in' : (todayEvents.length ? 'out' : 'not_arrived');

    res.json({
      staff_id: staffId, today, week_start: weekStart, status,
      since: day.open ? new Date(day.open.at).toISOString() : null,
      today_events: todayEvents,
      today_worked_minutes: day.workedMinutes,
      today_break_minutes: day.breakMinutes,
      week, week_worked_minutes: weekWorked,
      queries,
      // The one sentence that makes the whole thing defensible, shown on the page.
      note: 'Worked time is the sum of your tap-in / tap-out pairs. A break you tapped out for is not counted as work, and no leaving time is ever recorded for you — if a tap is missing you are asked what time it was.',
    });
  } catch (e) {
    if (e.code === '42P01') return res.json({ today_events: [], week: [], queries: [] });
    console.error('[clockin/my]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /webnfc — is the Android-tablet reading path switched on? ────────────
// Option 2 in CLOCKIN-SETUP.md, and deliberately behind a setting that is off.
// A second network reader is the answer; this exists so an office tap is possible
// the week the reader is late. Chrome-on-Android only (NDEFReader), HTTPS only.
router.get('/webnfc', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'clock_webnfc_enabled'");
    const enabled = String(rows[0]?.value || 'false') === 'true';
    const { rows: devs } = await db.query(
      "SELECT device_id, label, direction FROM clock_devices WHERE is_active = true AND kind = 'webnfc_tablet' ORDER BY label");
    res.json({ enabled, devices: devs, requires: 'Chrome on Android, over HTTPS. No other browser implements WebNFC.' });
  } catch (e) {
    res.json({ enabled: false, devices: [], error: e.message });
  }
});

module.exports = router;
