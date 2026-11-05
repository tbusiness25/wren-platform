'use strict';
// ===========================================================================
// b206 — ROOM MOVES (2026-08-19)
//
// One engine, three surfaces:
//   • Roost → Settings → "Room moves"          (the rules)
//   • Roost → Admissions → "Transfer window"   (the schedule, editable inline)
//   • scripts/report-engine-nightly.js         (the nightly job — NO new cron)
//
// Toby's rule (already applied to the data on 2026-08-19):
//   Baby Room → Pre-school on the MONDAY OF THE WEEK AFTER the child's 2nd
//   birthday, so occupancy is accurate.  Verified against the 16 production
//   Baby Room rows: transfer_planned_date == monday_of_week(dob + 2y) + 7 for
//   all 16, 0 mismatches.
//
// WHY THE BOOKING MATTERS: occupancy is computed from child_bookings.room_id,
// NOT children.room_id (occupancy-calendar.js skips a booking whose room_id
// isn't the room being counted).  So a "move" is a TRANSFER — close the old
// booking, open a new one in the new room from the effective date.
//
// b315 (2026-09-10): that transfer, the children.room_id write and the
// child_room_moves history row are now ONE call — setChildRoom() in
// src/lib/child-room.js — and this module calls it rather than assembling the
// three itself. Nothing in Wren may write a child's room any other way.
// ===========================================================================

// b315 — THE one room writer. This replaces the b206 arrangement of calling
// _propagateRoomChange() (the booking half) and writing children.room_id and the
// history row alongside it: three statements a caller had to remember, which is
// exactly how the halves came apart. setChildRoom() does all three.
const childRoom = require('./child-room');
const childDates = require('./child-dates');

// ── settings keys ──────────────────────────────────────────────────────────
const KEY_RULES  = 'room_move_rules';
const KEY_AUTO   = 'room_move_auto_apply';
const KEY_NOTICE = 'room_move_notice_weeks';
// Gates the NIGHTLY section itself (report-engine-nightly.js --only=roommoves).
// Defaults OFF so installing this build never moves a real child on night one.
const KEY_ENGINE = 'room_move_engine_auto';

const TRIGGERS = ['second_birthday', 'age_months', 'manual'];
// b315 added 'on_or_after' and made it the default. Toby, restating the rule:
// "the Monday on or after the child's 2nd birthday. If the birthday IS a Monday,
// that Monday." 'week_after' — the b206 default — differs from it in exactly one
// case, a birthday that falls on a Monday, where it waits a further week. Both
// are kept because a stored rule may still say 'week_after' and a manager's
// setting is theirs; the maths for 'on_or_after' is childDates.expectedRoomMoveDate,
// the same function the child's profile shows and the same rule as the SQL
// ladn.expected_room_move_date, so the screen and the engine cannot drift apart.
const TIMINGS  = ['same_week', 'week_after', 'next_month', 'on_or_after'];

const DEFAULT_RULES = {
  baby_to_preschool: {
    label: 'Baby Room → Pre-school',
    from_room_id: 1, to_room_id: 2,
    trigger: 'second_birthday', age_months: 24,
    timing: 'on_or_after', auto_apply: true, enabled: true,
  },
};

// ── date helpers (all UTC, all 'YYYY-MM-DD') ───────────────────────────────
const ymd = d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function addMonths(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return ymd(d); }
function addYears(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + n); return ymd(d); }
/** Monday of the week the given date falls in (ISO week — Mon..Sun). */
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;            // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return ymd(d);
}
/** First Mon–Fri of the month AFTER the given date. */
function startOfNextMonth(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const dow = first.getUTCDay();                  // 0 = Sun, 6 = Sat
  if (dow === 6) first.setUTCDate(first.getUTCDate() + 2);
  else if (dow === 0) first.setUTCDate(first.getUTCDate() + 1);
  return ymd(first);
}
function daysBetween(fromIso, toIso) {
  return Math.round((new Date(toIso + 'T00:00:00Z') - new Date(fromIso + 'T00:00:00Z')) / 86400000);
}
const today = () => ymd(new Date());

// ── the rule → date calculation ────────────────────────────────────────────
/**
 * The move date this rule dictates for a child with this date of birth.
 * Returns null when the rule can't produce one (manual trigger, or no DOB).
 */
function plannedDateFor(dob, rule) {
  if (!dob || !rule) return null;
  const d = ymd(dob);
  const trigger = TRIGGERS.includes(rule.trigger) ? rule.trigger : 'second_birthday';
  if (trigger === 'manual') return null;
  const anchor = trigger === 'age_months'
    ? addMonths(d, Number(rule.age_months) > 0 ? Number(rule.age_months) : 24)
    : addYears(d, 2);
  const timing = TIMINGS.includes(rule.timing) ? rule.timing : 'on_or_after';
  if (timing === 'same_week')  return mondayOf(anchor);
  if (timing === 'next_month') return startOfNextMonth(anchor);
  if (timing === 'week_after') return addDays(mondayOf(anchor), 7);
  return childDates.mondayOnOrAfter(anchor);      // on_or_after (b315, the default)
}

/** Human sentence for a rule — used in the UI and in notification bodies. */
function describeRule(rule) {
  if (!rule) return '';
  const t = rule.trigger === 'age_months'
    ? `${Number(rule.age_months) || 24} months old`
    : rule.trigger === 'manual' ? 'a manager setting a date' : 'their 2nd birthday';
  const when = rule.timing === 'same_week' ? 'the Monday of that week'
    : rule.timing === 'next_month' ? 'the start of the next month'
    : rule.timing === 'week_after' ? 'the Monday of the week after'
    : 'the Monday on or after that day';
  if (rule.trigger === 'manual') return 'Moved only when a manager sets a date — no automatic schedule.';
  return `When a child reaches ${t}, they move on ${when}.`;
}

// ── config load / save ─────────────────────────────────────────────────────
function normaliseRule(key, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    key,
    label: String(r.label || key.replace(/_/g, ' ')),
    from_room_id: r.from_room_id == null ? null : parseInt(r.from_room_id, 10),
    to_room_id:   r.to_room_id   == null ? null : parseInt(r.to_room_id, 10),
    trigger: TRIGGERS.includes(r.trigger) ? r.trigger : 'second_birthday',
    age_months: Number.isFinite(Number(r.age_months)) && Number(r.age_months) > 0 ? Number(r.age_months) : 24,
    timing: TIMINGS.includes(r.timing) ? r.timing : 'on_or_after',
    auto_apply: r.auto_apply === undefined ? true : !!r.auto_apply,
    enabled: r.enabled === undefined ? true : !!r.enabled,
  };
}

async function loadConfig(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key = ANY($1)`, [[KEY_RULES, KEY_AUTO, KEY_NOTICE, KEY_ENGINE]]);
  const bag = {};
  for (const r of rows) bag[r.key] = r.value;

  let parsed = null;
  try { parsed = bag[KEY_RULES] ? JSON.parse(bag[KEY_RULES]) : null; } catch (_) { parsed = null; }
  const src = (parsed && typeof parsed === 'object' && Object.keys(parsed).length) ? parsed : DEFAULT_RULES;
  const rules = Object.keys(src).map(k => normaliseRule(k, src[k]));

  const noticeWeeks = parseInt(bag[KEY_NOTICE], 10);
  return {
    rules,
    // Global master switch. A rule's own auto_apply can still turn ITS moves
    // into proposals, but the master OFF makes every rule propose.
    auto_apply: bag[KEY_AUTO] === undefined ? true : String(bag[KEY_AUTO]) === 'true',
    notice_weeks: Number.isFinite(noticeWeeks) && noticeWeeks >= 0 ? noticeWeeks : 4,
    // Is the nightly section switched on at all? Off = the rules are configured
    // but nothing runs unattended (manual moves from the UI still work).
    engine_auto: String(bag[KEY_ENGINE] || 'off') === 'on',
    seeded_defaults: !(parsed && Object.keys(parsed).length),
  };
}

async function saveConfig(db, body, actorId) {
  const patch = [];
  if (body.rules !== undefined) {
    const list = Array.isArray(body.rules) ? body.rules : Object.keys(body.rules || {}).map(k => ({ key: k, ...body.rules[k] }));
    const obj = {};
    for (const raw of list) {
      const key = String(raw.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      if (!key) continue;
      const n = normaliseRule(key, raw);
      if (n.from_room_id == null || n.to_room_id == null) throw new Error(`Rule "${key}" needs a from-room and a to-room`);
      if (n.from_room_id === n.to_room_id) throw new Error(`Rule "${key}" moves a child to the room they are already in`);
      delete n.key;
      obj[key] = n;
    }
    if (!Object.keys(obj).length) throw new Error('At least one room-move rule is required');
    patch.push([KEY_RULES, JSON.stringify(obj)]);
  }
  if (body.auto_apply !== undefined)   patch.push([KEY_AUTO, body.auto_apply ? 'true' : 'false']);
  if (body.engine_auto !== undefined)  patch.push([KEY_ENGINE, body.engine_auto ? 'on' : 'off']);
  if (body.notice_weeks !== undefined) {
    const w = parseInt(body.notice_weeks, 10);
    if (!Number.isFinite(w) || w < 0 || w > 52) throw new Error('Notice period must be 0–52 weeks');
    patch.push([KEY_NOTICE, String(w)]);
  }
  for (const [k, v] of patch) {
    await db.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [k, v, actorId || null]);
  }
  return loadConfig(db);
}

// ── the shared schedule (§5 forward view AND §7 Transfer window) ────────────
/**
 * Every child a rule applies to, with the date they are due to move.
 * ONE implementation — the occupancy/settings "upcoming moves" list and the
 * Admissions "Transfer window" list are the same query.
 *
 * opts: { asOf, horizonDays (null = no limit), includePast (default true),
 *         ruleKey, childId }
 */
async function listMoves(db, opts = {}) {
  const asOf = opts.asOf || today();
  const cfg  = opts.config || await loadConfig(db);
  const { rows: rooms } = await db.query(`SELECT id, name, capacity FROM rooms ORDER BY id`);
  const roomById = {}; for (const r of rooms) roomById[r.id] = r;

  const out = [];
  for (const rule of cfg.rules) {
    if (!rule.enabled) continue;
    const params = [rule.from_room_id];
    let where = `c.is_active = true AND c.room_id = $1
                 AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)
                 AND COALESCE(c.enrolment_status, 'attending') <> 'left'`;
    if (opts.childId) { params.push(opts.childId); where += ` AND c.id = $${params.length}`; }
    const { rows: kids } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
             c.room_id, c.transfer_planned_date, c.transfer_date_manual,
             c.key_person_id, c.leave_date,
             s.first_name || ' ' || s.last_name AS key_person_name,
             (SELECT b.room_id FROM child_bookings b
               WHERE b.child_id = c.id AND b.is_active = true
               ORDER BY b.id DESC LIMIT 1) AS booking_room_id
        FROM children c
        LEFT JOIN staff s ON s.id = c.key_person_id
       WHERE ${where}
       ORDER BY c.transfer_planned_date NULLS LAST, c.date_of_birth`, params);

    for (const c of kids) {
      const dob = c.date_of_birth ? ymd(c.date_of_birth) : null;
      const ruleDate = plannedDateFor(dob, rule);
      const stored   = c.transfer_planned_date ? ymd(c.transfer_planned_date) : null;
      const manual   = !!c.transfer_date_manual;
      const moveDate = stored || ruleDate;
      if (!moveDate) continue;                    // manual rule, no date set yet
      const days = daysBetween(asOf, moveDate);
      if (opts.horizonDays != null && days > opts.horizonDays) continue;
      if (opts.includePast === false && days < 0) continue;
      out.push({
        child_id: c.id,
        name: ((c.preferred_name || c.first_name || '') + ' ' + (c.last_name || '')).trim(),
        date_of_birth: dob,
        rule_key: rule.key,
        rule_label: rule.label,
        from_room_id: c.room_id,
        from_room: roomById[c.room_id] ? roomById[c.room_id].name : null,
        to_room_id: rule.to_room_id,
        to_room: roomById[rule.to_room_id] ? roomById[rule.to_room_id].name : null,
        booking_room_id: c.booking_room_id,
        // A booking already in the target room means the transfer has landed
        // even if this row still shows the old planned date.
        booking_already_moved: c.booking_room_id === rule.to_room_id,
        move_date: moveDate,
        rule_date: ruleDate,
        manual_override: manual,
        // A stored date that no longer matches the rule and isn't flagged manual
        // is drift — the recompute will straighten it out tonight.
        drifted: !manual && !!ruleDate && stored !== null && stored !== ruleDate,
        days_away: days,
        due: days <= 0,
        key_person_id: c.key_person_id,
        key_person_name: c.key_person_name,
        auto_apply: cfg.auto_apply && rule.auto_apply,
        leave_date: c.leave_date ? ymd(c.leave_date) : null,
      });
    }
  }
  out.sort((a, b) => a.move_date.localeCompare(b.move_date) || a.child_id - b.child_id);

  // Attach any outstanding proposal so the UI can show "awaiting confirmation".
  // Wrapped: an edition that has the code but not yet the b206 migration should
  // still get its schedule, minus the proposal badges.
  if (out.length) try {
    // Keyed on the CHILD, not (child, date): a proposal raised for an earlier
    // planned date is still the open question about this child.
    const { rows: pend } = await db.query(
      `SELECT DISTINCT ON (child_id) child_id, move_date, id, created_at
         FROM room_move_log
        WHERE kind = 'proposed' AND status = 'pending' AND child_id = ANY($1)
        ORDER BY child_id, created_at DESC`,
      [out.map(m => m.child_id)]);
    const byChild = {};
    for (const p of pend) byChild[p.child_id] = p;
    for (const m of out) {
      const p = byChild[m.child_id];
      if (p) m.proposal = { id: p.id, created_at: p.created_at, proposed_for: ymd(p.move_date) };
    }
  } catch (e) {
    if (!/room_move_log/.test(e.message)) throw e;   // only swallow "table isn't there yet"
  }
  return { as_of: asOf, config: cfg, rooms, moves: out };
}

// ── recompute planned dates from the rules ─────────────────────────────────
/**
 * Write transfer_planned_date for every child a rule covers.
 * NEVER touches a row flagged transfer_date_manual — a manager's edit wins.
 */
async function recomputePlannedDates(db, opts = {}) {
  const cfg = opts.config || await loadConfig(db);
  const changed = [];
  for (const rule of cfg.rules) {
    if (!rule.enabled || rule.trigger === 'manual') continue;
    const params = [rule.from_room_id];
    let extra = '';
    if (opts.childId) { params.push(opts.childId); extra = ` AND id = $${params.length}`; }
    const { rows: kids } = await db.query(`
      SELECT id, date_of_birth, transfer_planned_date
        FROM children
       WHERE is_active = true AND room_id = $1
         AND date_of_birth IS NOT NULL
         AND COALESCE(transfer_date_manual, false) = false
         AND (leave_date IS NULL OR leave_date >= CURRENT_DATE)${extra}`, params);
    for (const c of kids) {
      const want = plannedDateFor(ymd(c.date_of_birth), rule);
      const have = c.transfer_planned_date ? ymd(c.transfer_planned_date) : null;
      if (!want || want === have) continue;
      if (!opts.dryRun) {
        await db.query(`UPDATE children SET transfer_planned_date = $1 WHERE id = $2`, [want, c.id]);
      }
      changed.push({ child_id: c.id, rule_key: rule.key, from: have, to: want });
    }
  }
  return changed;
}

// ── apply one move ─────────────────────────────────────────────────────────
/**
 * Move a child's room via the ONE shared room writer.
 *
 * b206 did this in three statements — UPDATE children.room_id, then
 * _propagateRoomChange() for the booking, then the room_move_log row — and every
 * other caller in Wren had its own arrangement of the same three. b315 replaced
 * that with childRoom.setChildRoom(), which does the profile, the booking and the
 * child_room_moves history together and cannot do only some of them. The
 * room_move_log row below is this ENGINE's own record (what the nightly job did,
 * versus what happened to the child) and is kept.
 */
async function applyMove(db, { childId, toRoomId, effectiveDate, actorId, ruleKey, fromRoomId }) {
  const eff = effectiveDate || today();
  const move = await childRoom.setChildRoom(db, {
    childId, toRoomId, effectiveDate: eff, actorId, fromRoomId,
    source: 'room-move-engine', note: ruleKey ? `rule ${ruleKey}` : null,
  });
  if (!move.ok) {
    return { ok: false, reason: move.reason,
             detail: `setChildRoom refused this move: ${move.reason}` };
  }
  const from = move.from_room_id;

  await db.query(
    `INSERT INTO room_move_log (child_id, rule_key, from_room_id, to_room_id, move_date, kind, status, detail, created_by)
     VALUES ($1,$2,$3,$4,$5,'applied','done',$6,$7)
     ON CONFLICT (child_id, move_date, kind) DO UPDATE
       SET detail = EXCLUDED.detail, created_at = NOW()`,
    [childId, ruleKey || null, from, toRoomId, eff,
     move.booking.moved
       ? `booking moved: room ${move.booking.from} → ${move.booking.to} effective ${move.booking.effective}`
       : 'children.room_id updated; no active booking to move (occupancy reads child_bookings — check this child has a booking)',
     actorId || null]);

  // Any pending proposal for this child is now spent — matched on the CHILD, not
  // the date: an overdue move is applied effective today, so its proposal row
  // (raised against the original planned date) would otherwise sit pending for ever.
  await db.query(
    `UPDATE room_move_log SET status='confirmed', resolved_at=NOW(), resolved_by=$2
      WHERE kind='proposed' AND status='pending' AND child_id=$1`,
    [childId, actorId || null]);

  return {
    ok: true,
    child_id: childId, from_room_id: from, to_room_id: toRoomId, effective: eff,
    booking_moved: !!move.booking.moved,
    profile_updated: !!move.profile_updated,
    booking_note: move.booking.moved ? null : 'no active child_bookings row — occupancy will not change until one exists',
  };
}

// ── occupancy snapshot (proof that the counts agree) ────────────────────────
/**
 * Per-room head count for a date, counted the SAME WAY the occupancy views
 * count it — occupiedOn() in src/routes/occupancy-calendar.js: an active
 * booking whose date range covers the day AND whose weekday flag is set for
 * that day (a Mon/Wed/Fri child is not in the room on a Thursday). Weekends
 * are 0. Reported alongside:
 *   on_roll    — active bookings covering the date whatever their pattern
 *   on_profile — children.room_id, which is NOT what occupancy counts
 * If `booked` and `on_profile` disagree it usually means a child's room was
 * changed without their booking moving — the exact bug b206 exists to stop.
 * Closures are not applied here (occupancy-calendar zeroes closed days); this
 * is a raw booking count, so a bank holiday still reads its normal figure.
 */
const _DOW_COL = ['mon', 'tue', 'wed', 'thu', 'fri'];
async function occupancySnapshot(db, onDate) {
  const d = onDate || today();
  const dow = (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;   // 0 = Monday
  const col = dow < 5 ? _DOW_COL[dow] : null;                     // weekend → nobody
  const { rows } = await db.query(`
    SELECT r.id, r.name, r.capacity,
           COUNT(b.id) FILTER (WHERE b.is_active = true
                               AND b.start_date <= $1::date
                               AND (b.end_date IS NULL OR b.end_date >= $1::date)
                               ${col ? `AND b.${col} = true` : 'AND false'}) AS booked,
           COUNT(b.id) FILTER (WHERE b.is_active = true
                               AND b.start_date <= $1::date
                               AND (b.end_date IS NULL OR b.end_date >= $1::date)) AS on_roll,
           (SELECT COUNT(*) FROM children c
             WHERE c.is_active = true AND c.room_id = r.id) AS on_profile
      FROM rooms r
      LEFT JOIN child_bookings b ON b.room_id = r.id
     GROUP BY r.id, r.name, r.capacity
     ORDER BY r.id`, [d]);
  return { on: d, weekday: col, rooms: rows.map(r => ({
    room_id: r.id, name: r.name, capacity: r.capacity,
    booked: Number(r.booked), on_roll: Number(r.on_roll), on_profile: Number(r.on_profile),
  })) };
}

// ── the nightly job ────────────────────────────────────────────────────────
/**
 * Runs inside the existing nightly (report-engine-nightly.js `roommoves`
 * section) — there is NO new cron.
 *
 * Each night:
 *   1. recompute planned dates from the rules (skipping manual overrides)
 *   2. every child whose date is today-or-past and whose room still isn't the
 *      target →  auto_apply ? move them : raise ONE proposal for a manager
 *   3. every child `notice_weeks` out → ONE notification to the manager and the
 *      key person, deduped through room_move_log so it isn't sent nightly
 *
 * notify(recipientType, recipientId, title, body, link, category) is injected
 * so the nightly script's dispatcher-or-legacy helper is reused as-is.
 */
async function runRoomMoves(db, opts = {}) {
  const asOf   = opts.today || today();
  const dryRun = !!opts.dryRun;
  const log    = opts.log || (() => {});
  const notify = opts.notify || (async () => {});
  const cfg    = await loadConfig(db);

  const result = {
    as_of: asOf, dry_run: dryRun, auto_apply: cfg.auto_apply,
    recomputed: [], applied: [], proposed: [], notices: [], skipped: [],
    occupancy_before: null, occupancy_after: null,
  };

  result.recomputed = await recomputePlannedDates(db, { config: cfg, dryRun, childId: opts.childId || null });
  if (result.recomputed.length) {
    log(`room-moves: recomputed ${result.recomputed.length} planned date(s) from the rules`
      + `${dryRun ? ' (dry run — nothing written)' : ''}`);
  }

  // opts.childId — restrict the whole run to one child (the nightly's --child
  // flag). Testing only; a normal run passes nothing and covers everyone.
  const { moves } = await listMoves(db, { asOf, config: cfg, childId: opts.childId || null });
  result.occupancy_before = await occupancySnapshot(db, asOf);

  // ── due moves ────────────────────────────────────────────────────────────
  for (const m of moves) {
    if (!m.due) continue;
    if (m.from_room_id === m.to_room_id) continue;           // already in the target room
    if (m.booking_already_moved && m.from_room_id === m.to_room_id) continue;

    if (!m.auto_apply) {
      // §3 — auto_apply off means PROPOSE, not move.
      const { rows } = dryRun
        ? { rows: [] }
        : await db.query(
            `INSERT INTO room_move_log (child_id, rule_key, from_room_id, to_room_id, move_date, kind, status, detail)
             VALUES ($1,$2,$3,$4,$5,'proposed','pending',$6)
             ON CONFLICT (child_id, move_date, kind) DO NOTHING
             RETURNING id`,
            [m.child_id, m.rule_key, m.from_room_id, m.to_room_id, m.move_date,
             `auto-apply is off — ${m.name} is due to move ${m.from_room} → ${m.to_room} on ${m.move_date}`]);
      const isNew = dryRun || rows.length > 0;
      result.proposed.push({ ...pick(m), proposal_created: isNew });
      if (isNew && !dryRun) {
        await notify('all-managers', null,
          `🚪 Room move needs your OK — ${m.name}`,
          `${m.name} is due to move ${m.from_room} → ${m.to_room} on ${fmt(m.move_date)}.\n\n`
          + `Automatic room moves are switched OFF, so nothing has been changed. Confirm it on `
          + `Admissions → Transfer window and Wren will move the child and their booking together `
          + `(occupancy counts the booking, not the profile).`,
          '/index.html#admissions', 'room_move');
      }
      log(`room-moves: PROPOSED #${m.child_id} ${m.from_room} → ${m.to_room} on ${m.move_date}`
        + `${isNew ? '' : ' (proposal already open)'}`);
      continue;
    }

    // A move whose date has already gone by is applied EFFECTIVE TODAY, not
    // backdated. Backdating would open a booking starting months ago and quietly
    // rewrite historical occupancy — an unattended job must not do that. The
    // planned date is kept on the log row so the delay is visible. (A manager
    // editing the date by hand DOES get the date they typed — that is a
    // deliberate, audited statement about when the child actually moved.)
    const effective = m.move_date < asOf ? asOf : m.move_date;
    const late = effective !== m.move_date;

    if (dryRun) {
      result.applied.push({ ...pick(m), effective, late, booking_moved: null, dry_run: true });
      log(`room-moves: WOULD MOVE #${m.child_id} ${m.from_room} → ${m.to_room} effective ${effective}`
        + (late ? ` (planned ${m.move_date} — overdue, not backdated)` : ''));
      continue;
    }

    try {
      const res = await applyMove(db, {
        childId: m.child_id, toRoomId: m.to_room_id, effectiveDate: effective,
        ruleKey: m.rule_key, fromRoomId: m.from_room_id, actorId: null,
      });
      if (!res.ok) { result.skipped.push({ ...pick(m), reason: res.reason, detail: res.detail }); continue; }
      result.applied.push({ ...pick(m), effective, late, booking_moved: res.booking_moved, booking_note: res.booking_note });
      log(`room-moves: MOVED #${m.child_id} ${m.from_room} → ${m.to_room} effective ${effective}`
        + (late ? ` (planned ${m.move_date} — overdue, not backdated)` : '')
        + (res.booking_moved ? ' (booking moved)' : ' (NO ACTIVE BOOKING — occupancy unchanged)'));
      await notify(m.key_person_id ? 'staff' : 'all-managers', m.key_person_id || null,
        `🚪 ${m.name} has moved to ${m.to_room}`,
        `${m.name} moved from ${m.from_room} to ${m.to_room} today (${fmt(effective)}) — `
        + (late
            ? `their move was planned for ${fmt(m.move_date)} and was overdue, so it has been applied from today rather than backdated.`
            : `the Monday after their 2nd birthday, per the room-move rule.`)
        + `\n\n`
        + (res.booking_moved
            ? `Their booking has moved with them, so the register and the occupancy counts already show ${m.to_room}.`
            : `⚠️ They had no active booking, so the occupancy counts have NOT changed. Add a booking on their profile.`),
        `/child-profile.html?id=${m.child_id}`, 'room_move');
      await notify('all-managers', null,
        `🚪 Room move applied — ${m.name} → ${m.to_room}`,
        `${m.name} moved ${m.from_room} → ${m.to_room} on ${fmt(effective)}`
        + (late ? ` (planned ${fmt(m.move_date)} — overdue). ` : '. ')
        + `${res.booking_moved ? 'Booking moved too — occupancy is up to date.' : '⚠️ No active booking to move — occupancy is NOT up to date.'}`,
        '/index.html#admissions', 'room_move');
    } catch (e) {
      result.skipped.push({ ...pick(m), reason: 'error', detail: e.message });
      log(`room-moves: FAILED #${m.child_id} — ${e.message}`);
    }
  }

  // ── notice period (§4) — one per child per move, not nightly ─────────────
  const noticeDays = cfg.notice_weeks * 7;
  for (const m of moves) {
    if (m.due) continue;
    if (m.days_away > noticeDays) continue;
    let isNew = true;
    if (!dryRun) {
      const { rows } = await db.query(
        `INSERT INTO room_move_log (child_id, rule_key, from_room_id, to_room_id, move_date, kind, status, detail)
         VALUES ($1,$2,$3,$4,$5,'notice','sent',$6)
         ON CONFLICT (child_id, move_date, kind) DO NOTHING
         RETURNING id`,
        [m.child_id, m.rule_key, m.from_room_id, m.to_room_id, m.move_date,
         `${cfg.notice_weeks}-week notice for ${m.from_room} → ${m.to_room} on ${m.move_date}`]);
      isNew = rows.length > 0;
    }
    if (!isNew) continue;                        // already told them about THIS move
    result.notices.push({ ...pick(m) });
    log(`room-moves: NOTICE #${m.child_id} moves in ${m.days_away} day(s) (${m.move_date})`);
    if (dryRun) continue;
    const body =
      `${m.name} is due to move from ${m.from_room} to ${m.to_room} on ${fmt(m.move_date)} `
      + `— ${m.days_away} day${m.days_away === 1 ? '' : 's'} away.\n\n`
      + `That is the Monday of the week after their 2nd birthday. Time to settle them in, `
      + `hand over the key-person notes, and let their parents know.`;
    await notify(m.key_person_id ? 'staff' : 'all-managers', m.key_person_id || null,
      `📅 ${m.name} moves to ${m.to_room} in ${m.days_away} days`, body,
      `/child-profile.html?id=${m.child_id}`, 'room_move');
    if (m.key_person_id) {
      await notify('all-managers', null,
        `📅 Room move coming up — ${m.name} → ${m.to_room}`,
        body + `\n\nKey person: ${m.key_person_name || '—'}.`,
        '/index.html#admissions', 'room_move');
    }
  }

  result.occupancy_after = await occupancySnapshot(db, asOf);
  log(`room-moves: done — ${result.applied.length} ${dryRun ? 'WOULD move' : 'moved'}, `
    + `${result.proposed.length} ${dryRun ? 'would be proposed' : 'proposed'}, `
    + `${result.notices.length} notice(s)${dryRun ? ' would be sent' : ''}, ${result.skipped.length} skipped`
    + `${dryRun ? '  [DRY RUN — nothing was written]' : ''}`);
  return result;
}

function pick(m) {
  return {
    child_id: m.child_id, name: m.name, rule_key: m.rule_key,
    from_room_id: m.from_room_id, from_room: m.from_room,
    to_room_id: m.to_room_id, to_room: m.to_room,
    move_date: m.move_date, days_away: m.days_away,
    key_person_id: m.key_person_id, key_person_name: m.key_person_name,
  };
}
function fmt(iso) {
  try { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (_) { return iso; }
}

module.exports = {
  KEY_RULES, KEY_AUTO, KEY_NOTICE, KEY_ENGINE, TRIGGERS, TIMINGS, DEFAULT_RULES,
  loadConfig, saveConfig, describeRule,
  plannedDateFor, recomputePlannedDates,
  listMoves, applyMove, occupancySnapshot, runRoomMoves,
  // date helpers, exported for tests/scripts
  mondayOf, addDays, addMonths, addYears, startOfNextMonth, daysBetween, ymd,
};
