'use strict';
// ===========================================================================
// b206 — /api/room-moves (2026-08-19)
//
// The API behind three surfaces that all read the SAME list:
//   • Roost → Settings → "Room moves"        — the rules (GET/PUT /config)
//   • Roost → Admissions → "Transfer window" — the schedule (GET /upcoming),
//                                              editable inline (PUT /child/:id/date)
//   • the nightly job                        — src/lib/room-moves.js runRoomMoves()
//
// Every bit of the actual work lives in src/lib/room-moves.js so the route and
// the nightly job cannot drift apart, and so a move always goes through the one
// _propagateRoomChange() implementation in src/routes/children.js (occupancy is
// counted off child_bookings.room_id, not children.room_id).
// ===========================================================================
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const rm = require('../lib/room-moves');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// Reads: anyone who runs a room. Writes: manager-level only — this changes
// where children are counted, and the room a child is in.
const READ_ROLES  = ['manager', 'deputy_manager', 'admin', 'room_leader'];
const WRITE_ROLES = ['manager', 'deputy_manager', 'admin'];
const canRead  = (req, res, next) => hasRole(req.user, READ_ROLES)
  ? next() : res.status(403).json({ error: 'Manager or room leader access required' });
const canWrite = (req, res, next) => hasRole(req.user, WRITE_ROLES)
  ? next() : res.status(403).json({ error: 'Manager access required' });

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ── GET /config — the three settings keys, plus what the UI needs to render ──
router.get('/config', canRead, async (req, res) => {
  try {
    const db = getPool();
    const cfg = await rm.loadConfig(db);
    const { rows: rooms } = await db.query(`SELECT id, name, capacity FROM rooms ORDER BY id`);
    res.json({
      ...cfg,
      rules: cfg.rules.map(r => ({ ...r, description: rm.describeRule(r) })),
      rooms,
      triggers: rm.TRIGGERS,
      timings: rm.TIMINGS,
      keys: { rules: rm.KEY_RULES, auto_apply: rm.KEY_AUTO, notice_weeks: rm.KEY_NOTICE, engine_auto: rm.KEY_ENGINE },
    });
  } catch (e) { console.error('[room-moves/config]', e); res.status(500).json({ error: e.message }); }
});

// ── PUT /config — write any of the three keys ───────────────────────────────
// Body: { rules: [...] | {...}, auto_apply: bool, notice_weeks: int }
// Saving the rules re-derives every non-manual planned date immediately, so the
// Transfer-window list reflects the new rule without waiting for the nightly.
router.put('/config', canWrite, async (req, res) => {
  try {
    const db = getPool();
    const cfg = await rm.saveConfig(db, req.body || {}, req.user.id);
    const recomputed = await rm.recomputePlannedDates(db, { config: cfg });
    recordAudit({ req, action: 'update', entity_type: 'settings', entity_id: null,
      meta: { room_moves: true, keys: Object.keys(req.body || {}), recomputed: recomputed.length } });
    res.json({
      ...cfg,
      rules: cfg.rules.map(r => ({ ...r, description: rm.describeRule(r) })),
      recomputed,
    });
  } catch (e) {
    const bad = /needs a|already in|required|0–52/.test(e.message);
    if (!bad) console.error('[room-moves/config PUT]', e);
    res.status(bad ? 400 : 500).json({ error: e.message });
  }
});

// ── GET /upcoming — the ONE forward-view list (§5 and §7) ───────────────────
// ?horizon_days=N   limit how far ahead (default: everything)
// ?include_past=0   drop overdue rows
// ?occupancy=1      attach the live per-room counts alongside
router.get('/upcoming', canRead, async (req, res) => {
  try {
    const db = getPool();
    const horizon = req.query.horizon_days != null && req.query.horizon_days !== ''
      ? parseInt(req.query.horizon_days, 10) : null;
    const out = await rm.listMoves(db, {
      horizonDays: Number.isFinite(horizon) ? horizon : null,
      includePast: req.query.include_past !== '0',
    });
    if (req.query.occupancy === '1') out.occupancy = await rm.occupancySnapshot(db);
    res.json(out);
  } catch (e) { console.error('[room-moves/upcoming]', e); res.status(500).json({ error: e.message }); }
});

// ── PUT /child/:id/date — inline edit on the Transfer-window list (§7) ───────
// Body: { date: 'YYYY-MM-DD' | null, apply_now?: bool }
//   date set   → transfer_planned_date = date, transfer_date_manual = true
//                (so the nightly recompute leaves it alone), and if the date is
//                today or in the past the move happens NOW, booking and all.
//   date null  → clears the override; the date falls back to the rule.
router.put('/child/:id/date', canWrite, async (req, res) => {
  const childId = parseInt(req.params.id, 10);
  if (!Number.isFinite(childId)) return res.status(404).json({ error: 'Not found' });
  const date = req.body && req.body.date ? String(req.body.date).slice(0, 10) : null;
  if (date && !ISO.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const db = getPool();
    const cfg = await rm.loadConfig(db);
    const before = await rm.listMoves(db, { childId, config: cfg });
    const row = before.moves[0] || null;

    if (!date) {
      // Back to the rule.
      await db.query(`UPDATE children SET transfer_date_manual = false WHERE id = $1`, [childId]);
      const ruleDate = row && row.rule_date ? row.rule_date : null;
      await db.query(`UPDATE children SET transfer_planned_date = $1 WHERE id = $2`, [ruleDate, childId]);
      recordAudit({ req, action: 'update', entity_type: 'child', entity_id: childId,
        meta: { room_move_date_cleared: true, back_to_rule: ruleDate } });
      const after = await rm.listMoves(db, { childId, config: cfg });
      return res.json({ ok: true, cleared: true, move: after.moves[0] || null });
    }

    await db.query(
      `UPDATE children SET transfer_planned_date = $1, transfer_date_manual = true, updated_at = NOW()
        WHERE id = $2`, [date, childId]);

    // Today or past → move now, through the same path the nightly job uses.
    let applied = null;
    const isDue = date <= rm.ymd(new Date());
    if (isDue && row && row.to_room_id && row.from_room_id !== row.to_room_id) {
      applied = await rm.applyMove(db, {
        childId, toRoomId: row.to_room_id, effectiveDate: date,
        ruleKey: row.rule_key, fromRoomId: row.from_room_id, actorId: req.user.id,
      });
    }
    recordAudit({ req, action: 'update', entity_type: 'child', entity_id: childId,
      meta: { room_move_date: date, manual_override: true, applied: applied || false } });

    const after = await rm.listMoves(db, { childId, config: cfg });
    res.json({
      ok: true, date, manual_override: true, applied,
      move: after.moves[0] || null,
      occupancy: await rm.occupancySnapshot(db),
    });
  } catch (e) { console.error('[room-moves/child date]', e); res.status(500).json({ error: e.message }); }
});

// ── POST /child/:id/apply — confirm a proposal, or move a child now ─────────
router.post('/child/:id/apply', canWrite, async (req, res) => {
  const childId = parseInt(req.params.id, 10);
  if (!Number.isFinite(childId)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const { moves } = await rm.listMoves(db, { childId });
    const row = moves[0];
    if (!row) return res.status(404).json({ error: 'No room-move rule applies to this child' });
    const eff = req.body && req.body.date && ISO.test(String(req.body.date).slice(0, 10))
      ? String(req.body.date).slice(0, 10) : row.move_date;
    const before = await rm.occupancySnapshot(db);
    const applied = await rm.applyMove(db, {
      childId, toRoomId: row.to_room_id, effectiveDate: eff,
      ruleKey: row.rule_key, fromRoomId: row.from_room_id, actorId: req.user.id,
    });
    recordAudit({ req, action: 'update', entity_type: 'child', entity_id: childId,
      meta: { room_move_applied: applied } });
    res.json({ ...applied, occupancy_before: before, occupancy_after: await rm.occupancySnapshot(db) });
  } catch (e) { console.error('[room-moves/apply]', e); res.status(500).json({ error: e.message }); }
});

// ── POST /child/:id/dismiss — leave the child where they are for now ────────
router.post('/child/:id/dismiss', canWrite, async (req, res) => {
  const childId = parseInt(req.params.id, 10);
  if (!Number.isFinite(childId)) return res.status(404).json({ error: 'Not found' });
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE room_move_log SET status='dismissed', resolved_at=NOW(), resolved_by=$2,
              detail = COALESCE(detail,'') || ' | dismissed: ' || COALESCE($3,'no reason given')
        WHERE kind='proposed' AND status='pending' AND child_id=$1`,
      [childId, req.user.id, req.body && req.body.reason ? String(req.body.reason).slice(0, 300) : null]);
    recordAudit({ req, action: 'update', entity_type: 'child', entity_id: childId,
      meta: { room_move_proposal_dismissed: rowCount } });
    res.json({ ok: true, dismissed: rowCount });
  } catch (e) { console.error('[room-moves/dismiss]', e); res.status(500).json({ error: e.message }); }
});

// ── POST /run — run the job on demand (the nightly runs the same function) ──
// Body: { dry_run: bool }.  Defaults to a DRY RUN: a manager pressing a button
// should see what would happen before anything moves.
router.post('/run', canWrite, async (req, res) => {
  try {
    const db = getPool();
    const dryRun = !(req.body && req.body.dry_run === false);
    const { notifyAsync } = require('../services/notification-dispatcher');
    const notify = async (recipientType, recipientId, title, body, link, category) => {
      try { await notifyAsync(category || 'room_move', recipientType, recipientId, title, body, { link }); }
      catch (e) { console.error('[room-moves] notify failed:', e.message); }
    };
    const lines = [];
    const out = await rm.runRoomMoves(db, {
      dryRun, notify, log: (...a) => lines.push(a.join(' ')),
    });
    recordAudit({ req, action: 'update', entity_type: 'settings', entity_id: null,
      meta: { room_moves_run: true, dry_run: dryRun, applied: out.applied.length, proposed: out.proposed.length } });
    res.json({ ...out, log: lines });
  } catch (e) { console.error('[room-moves/run]', e); res.status(500).json({ error: e.message }); }
});

// ── GET /log — the audit trail (applied / proposed / notices) ───────────────
router.get('/log', canRead, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT l.*, r1.name AS from_room, r2.name AS to_room
        FROM room_move_log l
        LEFT JOIN rooms r1 ON r1.id = l.from_room_id
        LEFT JOIN rooms r2 ON r2.id = l.to_room_id
       ORDER BY l.created_at DESC LIMIT $1`, [Math.min(parseInt(req.query.limit, 10) || 100, 500)]);
    res.json({ entries: rows });
  } catch (e) { console.error('[room-moves/log]', e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
