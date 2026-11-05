'use strict';
/**
 * offratio.js — b189 (2026-08-19). Mounted at /api/offratio.
 *
 * OFF-RATIO ACCOUNTABILITY. When a room runs materially above the staffing its
 * booked children require, the room leader is asked — the next morning — to record
 * in words how that time was used. The entry cannot be dismissed empty.
 *
 *   GET  /api/offratio/outstanding      entries with no account yet (manager: all;
 *                                       room leader: their own rooms)
 *   GET  /api/offratio/mine             the signed-in user's own outstanding entries
 *   GET  /api/offratio/:id              one entry with the per-slot working
 *   POST /api/offratio/:id/account      submit the written account (required)
 *   GET  /api/offratio/summary          ?from=&to= — for the monthly report
 *   GET  /api/offratio/staff/:staffId   a practitioner's own off-ratio time (b183)
 *   POST /api/offratio/run              manager: recompute a date now (same code
 *                                       path the nightly job uses)
 *
 * WHY THIS IS NOT A DISCIPLINARY TOOL — and the wording in the UI must keep saying
 * so: being over ratio is usually deliberate and good (settling, SEND support,
 * planning, supervision, a student on top of the count). What was missing was the
 * ability to answer "what did we do with the extra hands on Monday?" at all — and,
 * just as much, the ability for a practitioner to answer "I had no off-ratio time"
 * with data rather than memory. Both directions matter.
 *
 * Everything computed lives in src/lib/offratio.js so this router, the nightly job
 * in scripts/report-engine-nightly.js and the staff-performance page cannot drift
 * apart in their arithmetic.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const offratio = require('../lib/offratio');

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];
const isManager = req => MANAGER_ROLES.includes(req.user && req.user.role);
const managerOnly = (req, res, next) =>
  isManager(req) ? next() : res.status(403).json({ error: 'Manager access required' });

// Minimum words for an account. Low deliberately — the bar is "a sentence", not an
// essay. It exists only to stop the entry being dismissed with a full stop.
const MIN_ACCOUNT_CHARS = 15;

function ymd(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }

/** Shape one offratio_log row for the client, including the human-readable prompt. */
function shape(r) {
  const date = ymd(r.date);
  return {
    id: r.id,
    date,
    room_id: r.room_id,
    room_name: r.room_name || null,
    room_leader_id: r.room_leader_id,
    room_leader: r.leader_first ? `${r.leader_first} ${r.leader_last}` : null,
    surplus_minutes: r.surplus_minutes,
    surplus_human: offratio.humanMinutes(r.surplus_minutes),
    prompt: offratio.promptLine(date, r.room_name || `Room ${r.room_id}`, r.surplus_minutes),
    account: r.account || null,
    outstanding: !r.account,
    submitted_at: r.submitted_at,
    submitted_by: r.submitted_by,
    notified_at: r.notified_at,
    detail: r.detail || null,
  };
}

const SELECT_LOG = `
  SELECT ol.*, rm.name AS room_name,
         s.first_name AS leader_first, s.last_name AS leader_last
    FROM offratio_log ol
    LEFT JOIN rooms rm ON rm.id = ol.room_id
    LEFT JOIN staff s  ON s.id = ol.room_leader_id`;

// ── GET /api/offratio/outstanding ────────────────────────────────────────────
// Managers see every outstanding entry (this is the manager-dashboard feed).
// Anyone else sees only entries addressed to them — a practitioner has no business
// reading another room's account.
router.get('/outstanding', async (req, res) => {
  try {
    const db = getPool();
    const params = [];
    let where = 'WHERE ol.account IS NULL';
    if (!isManager(req)) { params.push(req.user.id); where += ` AND ol.room_leader_id = $${params.length}`; }
    const { rows } = await db.query(`${SELECT_LOG} ${where} ORDER BY ol.date DESC, ol.room_id`, params);
    const items = rows.map(shape);
    res.json({
      count: items.length,
      oldest: items.length ? items[items.length - 1].date : null,
      total_surplus_minutes: items.reduce((a, i) => a + (i.surplus_minutes || 0), 0),
      items,
      note: 'Being over ratio is usually deliberate and good. These entries ask what the '
          + 'time was used for — they are not a finding against anyone.',
    });
  } catch (err) {
    console.error('offratio /outstanding error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/offratio/mine ───────────────────────────────────────────────────
// What the room leader is being asked for. Managers get their own rooms here too
// (use /outstanding for the whole-setting view).
router.get('/mine', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `${SELECT_LOG} WHERE ol.room_leader_id = $1 ORDER BY ol.account IS NOT NULL, ol.date DESC`,
      [req.user.id]);
    const items = rows.map(shape);
    res.json({ count: items.length, outstanding: items.filter(i => i.outstanding).length, items });
  } catch (err) {
    console.error('offratio /mine error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/offratio/summary?from=&to= — the monthly-report feed ────────────
router.get('/summary', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))   ? req.query.to   : new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : null;
    const params = [to];
    let where = 'WHERE ol.date <= $1::date';
    if (from) { params.push(from); where += ` AND ol.date >= $${params.length}::date`; }

    const { rows } = await db.query(`${SELECT_LOG} ${where} ORDER BY ol.date DESC, ol.room_id`, params);
    const items = rows.map(shape);
    const byRoom = {};
    for (const i of items) {
      const k = i.room_id;
      byRoom[k] = byRoom[k] || { room_id: k, room_name: i.room_name, days: 0, surplus_minutes: 0, outstanding: 0 };
      byRoom[k].days++;
      byRoom[k].surplus_minutes += i.surplus_minutes || 0;
      if (i.outstanding) byRoom[k].outstanding++;
    }
    for (const r of Object.values(byRoom)) r.surplus_human = offratio.humanMinutes(r.surplus_minutes);
    res.json({
      from, to,
      days_logged: items.length,
      outstanding: items.filter(i => i.outstanding).length,
      accounted: items.filter(i => !i.outstanding).length,
      total_surplus_minutes: items.reduce((a, i) => a + (i.surplus_minutes || 0), 0),
      total_surplus_human: offratio.humanMinutes(items.reduce((a, i) => a + (i.surplus_minutes || 0), 0)),
      by_room: Object.values(byRoom),
      items,
    });
  } catch (err) {
    console.error('offratio /summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/offratio/staff/:staffId — a practitioner's own off-ratio time ───
// Anyone may read their OWN figure (that is the point — "I had no off-ratio time"
// becomes answerable). Reading someone else's requires a manager role.
router.get('/staff/:staffId', async (req, res) => {
  const staffId = parseInt(req.params.staffId, 10);
  if (!Number.isFinite(staffId)) return res.status(400).json({ error: 'staffId required' });
  if (staffId !== req.user.id && !isManager(req)) {
    return res.status(403).json({ error: 'You can only view your own off-ratio time' });
  }
  try {
    const db = getPool();
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to : new Date().toISOString().slice(0, 10);
    const days = Math.min(365, Math.max(7, parseInt(req.query.days || '90', 10) || 90));
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))
      ? req.query.from
      : new Date(new Date(to + 'T00:00:00Z').getTime() - days * 86400000).toISOString().slice(0, 10);
    res.json(await offratio.staffOffRatioMinutes(db, staffId, from, to));
  } catch (err) {
    console.error('offratio /staff error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/offratio/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`${SELECT_LOG} WHERE ol.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (!isManager(req) && rows[0].room_leader_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your entry' });
    }
    res.json(shape(rows[0]));
  } catch (err) {
    console.error('offratio /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/offratio/:id/account — the written account ─────────────────────
// The whole feature turns on this being REQUIRED. There is no dismiss route and no
// "N/A" shortcut: an entry leaves the outstanding list only when somebody has said
// what the time was for.
router.post('/:id/account', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  const account = String((req.body && req.body.account) || '').trim();
  if (account.length < MIN_ACCOUNT_CHARS) {
    return res.status(400).json({
      error: 'account_required',
      message: `Please write a sentence about how the time was used (at least ${MIN_ACCOUNT_CHARS} characters). `
             + 'Off-ratio time is usually well spent — settling, SEND support, planning, supervision — '
             + 'this just records which.',
    });
  }
  try {
    const db = getPool();
    const { rows: existing } = await db.query('SELECT * FROM offratio_log WHERE id = $1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    // The room leader it was addressed to, or any manager, may answer. If nobody was
    // attached to the room the entry went to the managers, so managers can answer it.
    if (!isManager(req) && existing[0].room_leader_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your entry' });
    }
    const { rows } = await db.query(
      `UPDATE offratio_log
          SET account = $2, submitted_at = now(), submitted_by = $3
        WHERE id = $1 RETURNING id`, [id, account, req.user.id]);
    res.json({ ok: true, id: rows[0].id, accounted: true });
  } catch (err) {
    console.error('offratio /account error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/offratio/run — manager: recompute a date now ───────────────────
// Same code path as the nightly job (scripts/report-engine-nightly.js --only=offratio),
// so what a manager sees here is exactly what the overnight run would have written.
// notify=1 also sends the room-leader notifications; default is compute-and-store only.
router.post('/run', managerOnly, async (req, res) => {
  const date = String((req.body && req.body.date) || req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  try {
    const db = getPool();
    // Optional explicit overrides. These exist so a manager can ask "what would this
    // say with a lower bar?" WITHOUT editing the settings that govern the nightly run
    // — the settings stay the policy, this is a one-off look. Both are echoed back in
    // the result so a row written under an override is never mistaken for a normal one.
    const body = req.body || {};
    const opts = {};
    const thr = parseInt(body.threshold_minutes != null ? body.threshold_minutes : req.query.threshold_minutes, 10);
    if (Number.isFinite(thr) && thr >= 0) opts.thresholdMinutes = thr;
    const cov = parseFloat(body.min_coverage != null ? body.min_coverage : req.query.min_coverage);
    if (Number.isFinite(cov) && cov >= 0 && cov <= 1) opts.minCoverage = cov;

    const result = await offratio.logSurplusDay(db, date, opts);
    result.overrides_applied = Object.keys(opts).length ? opts : null;
    if (String((req.body && req.body.notify) || req.query.notify || '') === '1') {
      const { notifyOffRatio } = require('../lib/offratio-notify');
      result.notified = await notifyOffRatio(db, result);
    }
    res.json(result);
  } catch (err) {
    console.error('offratio /run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
