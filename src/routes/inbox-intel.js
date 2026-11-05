'use strict';
/**
 * inbox-intel.js — b235 (2026-08-26)
 *
 *   GET  /api/inbox-intel/summary      Part A — what was missed
 *   GET  /api/inbox-intel/gmail        Part B — the mailbox sweep
 *   GET  /api/inbox-intel/todo         the "1. TO DO" backlog, aged
 *   GET  /api/inbox-intel/queue        the router's ranked queue
 *   GET  /api/inbox-intel/prevention   Part D — how to stop it happening
 *   POST /api/inbox-intel/classify     route one item (no persistence)
 *   GET  /api/inbox-intel/model        which local model, and proof it is local
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Manager role AND the admin (Roost) portal, checked server-side, exactly the
 * shape src/routes/attention.js uses and for the same reason: a manager signed
 * in on the EY portal carries a token with audience 'learning', and that token
 * passes requireRole('manager') on every shared route. This endpoint aggregates
 * parent correspondence and enquiry revenue. It belongs on one portal, so the
 * portal is checked as well as the role.
 *
 * ── WHAT COMES BACK ─────────────────────────────────────────────────────────
 * Aggregates, ids and hashed refs. No subject line, no body, no address, no
 * name — the analysis is deliberately built so those never leave memory in the
 * first place. /classify is the one endpoint that accepts free text, and it
 * accepts it from the caller, stores nothing, and returns only a verdict.
 */

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const intel = require('../lib/inbox-intel');
const inboxRouter = require('../services/inbox-router');
const sovereign = require('../lib/sovereign-model');
const { getPool } = require('../db/pool');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

function managerAdminOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'Inbox intelligence is available on the Roost (admin) portal only.',
    });
  }
  if (!req.user || !hasRole(req.user, ['manager', 'admin'])) {
    return res.status(403).json({
      error: 'forbidden_role',
      message: 'Manager access only — this reads parent correspondence and enquiry revenue.',
    });
  }
  next();
}

const guard = [authenticate, managerAdminOnly];

const fail = (res, e) => res.status(500).json({ error: 'inbox_intel_failed', message: e.message });

// ── Part A ──────────────────────────────────────────────────────────────────
router.get('/summary', guard, async (req, res) => {
  try { res.json(await intel.partA()); } catch (e) { fail(res, e); }
});

// ── Part B ──────────────────────────────────────────────────────────────────
router.get('/gmail', guard, async (req, res) => {
  try {
    const db = getPool();
    const stats = await intel.gmailStats();
    const { rows } = await db.query(
      `SELECT key, phase, listed, fetched, errors, started_at, updated_at, finished_at
         FROM inbox_sweep_state ORDER BY key`);
    const leak = await intel.delegationLeak();
    res.json({ sweep: rows, stats, delegation: leak });
  } catch (e) { fail(res, e); }
});

router.get('/todo', guard, async (req, res) => {
  try { res.json(await intel.todoBacklog()); } catch (e) { fail(res, e); }
});

// ── the queue ───────────────────────────────────────────────────────────────
// Ranked, and ranked once. The whole point is that he does not sort it himself.
const LANE_ORDER = { 'reply-now': 0, 'delegate-to-ayla': 1, 'schedule': 2, 'waiting-on-someone-else': 3, 'no-action': 4 };
router.get('/queue', guard, async (req, res) => {
  try {
    const db = getPool();
    const lane = req.query.lane && inboxRouter.LANES.includes(req.query.lane) ? req.query.lane : null;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const { rows } = await db.query(`
      SELECT id, item_kind, item_ref, lane, urgency, who, deadline, suggested_action,
             (draft_reply IS NOT NULL) AS has_draft, confidence, topic,
             forced, forced_key, forced_reason, verdict_source, model, created_at
        FROM inbox_router_verdicts
       ${lane ? 'WHERE lane = $1' : ''}
       ORDER BY
         CASE urgency WHEN 'red' THEN 0 WHEN 'amber' THEN 1 ELSE 2 END,
         forced DESC,
         confidence DESC
       LIMIT ${limit}`, lane ? [lane] : []);
    res.json({ counts: await intel.laneDistribution(), lane, items: rows });
  } catch (e) { fail(res, e); }
});

// A draft is only ever handed over one at a time, on request, to a manager on
// the admin portal. Nothing in b235 sends it.
router.get('/queue/:id/draft', guard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, lane, draft_reply, suggested_action FROM inbox_router_verdicts WHERE id = $1`,
      [parseInt(req.params.id, 10)]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(Object.assign({ warning: 'DRAFT ONLY — b235 never sends anything.' }, rows[0]));
  } catch (e) { fail(res, e); }
});

// ── Part D ──────────────────────────────────────────────────────────────────
router.get('/prevention', guard, async (req, res) => {
  try {
    res.json(await intel.prevention({ narrative: req.query.narrative !== '0' }));
  } catch (e) { fail(res, e); }
});

// ── classify one item, store nothing ────────────────────────────────────────
router.post('/classify', guard, async (req, res) => {
  try {
    const b = req.body || {};
    const item = {
      kind: b.kind || 'adhoc',
      subject: b.subject || null,
      snippet: b.snippet || null,
      body: b.body || null,
      labels: Array.isArray(b.labels) ? b.labels : [],
      last_direction: b.last_direction || 'in',
      age_days: b.age_days == null ? null : Number(b.age_days),
      answered: b.answered === true,
      list_id: b.list_id === true,
    };
    const verdict = await inboxRouter.classify(item, { useModel: b.use_model !== false });
    res.json({ verdict, stored: false });
  } catch (e) { fail(res, e); }
});

// ── proof of sovereignty ────────────────────────────────────────────────────
// Not decoration. "Which model saw the parents' email" is a question that has
// to have an answer on demand, and this is it.
router.get('/model', guard, async (req, res) => {
  try {
    const s = await sovereign.assertSovereign();
    res.json({
      host: s.host, model: s.model, available: s.available,
      cloud_fallback: false,
      note: 'src/lib/sovereign-model.js refuses any host that is not a private, loopback or Tailscale-CGNAT IP literal, re-checked before every request. There is no cloud provider in the module.',
    });
  } catch (e) {
    res.status(503).json({
      error: 'sovereign_model_unavailable', message: e.message,
      cloud_fallback: false,
      note: 'By design there is nothing to fall back to — nursery correspondence is never sent to a cloud model.',
    });
  }
});

module.exports = router;
