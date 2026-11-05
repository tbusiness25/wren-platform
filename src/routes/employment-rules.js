'use strict';
/* ===========================================================================
 * employment-rules.js — b318 (2026-09-11)
 *
 * "People need to be clear about what the rules are."
 *
 * One place to ask: what is the rule here, whose rule is it, and does this
 * particular request break it. Every answer carries its source. Nothing in this
 * file states a legal position without naming the document it comes from —
 * that is a rule of the build, not a nicety, because an unsourced legal claim
 * in a nursery's HR system is worse than no claim at all.
 *
 * WHO SEES WHAT
 *   * The RULES themselves are readable by every member of staff. A rule people
 *     cannot read is not a rule, it is a trap.
 *   * A leave check runs for YOURSELF, or for anyone if you are a manager.
 *   * SSP figures are pay data — manager-only, and the person themselves.
 *   * Changing a rule's enforcement is manager-only and recorded.
 * =========================================================================== */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const ER = require('../lib/employment-rules');
const svc = require('../services/employment-rules-service');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const isManager = req => MANAGER_ROLES.includes(req.user && req.user.role);

router.use(authenticate);

// ── GET / — the whole catalogue, grouped by domain ──────────────────────────
// Readable by everyone. `enforcement` is shown so nobody is surprised by which
// rules can actually stop them and which only flag.
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const rules = await svc.loadRules(db, req.query.domain || null);
    const out = [];
    for (const [key, row] of rules) {
      const r = ER.ruleFor(rules, key);
      out.push({
        rule_key: key,
        title: row.title,
        domain: row.domain,
        rule: r.rule,
        source: r.source,
        source_kind: row.source_kind,
        source_ref: row.source_ref,
        source_url: row.source_url,
        anchor: row.handbook_anchor,
        enforcement: row.enforcement,
        is_active: row.is_active,
        // Whether a check actually runs behind this rule today. A rule that is
        // published but unenforceable says so rather than letting the screen
        // imply Wren is watching something it is not.
        evaluated: r.evaluated,
        supersedes_handbook: row.supersedes_handbook,
        config: row.config,
        notes: isManager(req) ? row.notes : null,
      });
    }
    const domains = {};
    for (const r of out) (domains[r.domain] = domains[r.domain] || []).push(r);
    res.json({
      count: out.length,
      checked: out.filter(r => r.evaluated && r.is_active && r.enforcement !== 'off').length,
      domains,
      rules: out,
      note: 'Where our handbook sets a rule, Wren enforces the handbook. Where it is silent, the law. Where the handbook is below the legal minimum, the law — and the handbook paragraph is flagged.',
    });
  } catch (e) {
    console.error('[employment-rules] catalogue:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:rule_key — manager changes enforcement / numbers ──────────────────
// Additive by nature: it never creates a rule, only adjusts one that shipped.
// A rule's SOURCE is not editable here — you cannot relabel a statute.
router.put('/:rule_key', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const { enforcement, is_active, config } = req.body || {};
  if (enforcement && !['warn', 'block', 'off'].includes(enforcement)) {
    return res.status(400).json({ error: "enforcement must be 'warn', 'block' or 'off'" });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE ${SCHEMA()}.employment_rules
         SET enforcement = COALESCE($2, enforcement),
             is_active   = COALESCE($3, is_active),
             config      = COALESCE($4::jsonb, config),
             updated_by  = $5,
             updated_at  = now()
       WHERE rule_key = $1
       RETURNING rule_key, title, enforcement, is_active, config`,
      [req.params.rule_key,
       enforcement || null,
       typeof is_active === 'boolean' ? is_active : null,
       config ? JSON.stringify(config) : null,
       req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'No such rule' });
    await recordAudit({
      req, action: 'update', entity_type: 'employment_rule', entity_id: req.params.rule_key,
      meta: { rule_key: req.params.rule_key, enforcement: rows[0].enforcement, is_active: rows[0].is_active },
    }).catch(() => {});
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /leave-check — the rules against a proposed (or saved) request ─────
// Body: { start_date, end_date, request_type?, staff_id?, request_id? }
// staff_id is self unless you are a manager. This is the endpoint the HR leave
// form and the Roost approval queue BOTH call, so the sentence a practitioner
// reads before submitting is the sentence the manager reads when deciding.
router.post('/leave-check', async (req, res) => {
  const b = req.body || {};
  const staffId = b.staff_id && isManager(req) ? Number(b.staff_id) : req.user.id;
  if (!b.start_date) return res.status(400).json({ error: 'start_date required' });
  try {
    const db = getPool();
    const result = await svc.leaveCheck(db, {
      staff_id: staffId,
      start_date: b.start_date,
      end_date: b.end_date || b.start_date,
      request_type: b.request_type || 'holiday',
      exclude_request_id: b.request_id || 0,
      now: b.now ? new Date(b.now) : undefined,
    });
    if (b.request_id) result.overrides = await svc.overridesFor(db, 'absence_request', Number(b.request_id));
    res.json(result);
  } catch (e) {
    console.error('[employment-rules] leave-check:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /absence/:id — every rule that bears on one saved absence ───────────
router.get('/absence/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.*, COALESCE(ar.request_type, ar.absence_type, 'holiday') AS kind
        FROM ${SCHEMA()}.absence_requests ar WHERE ar.id=$1`, [req.params.id]);
    const a = rows[0];
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.staff_id !== req.user.id && !isManager(req)) return res.status(403).json({ error: 'Forbidden' });

    const rules = await svc.loadRules(db);
    const out = { absence_id: a.id, staff_id: a.staff_id, kind: a.kind, findings: [] };

    if (a.kind === 'sick') {
      const sick = await svc.sicknessCheck(db, a, { rules });
      out.findings.push(...sick.findings);
    } else {
      const leave = await svc.leaveCheck(db, {
        staff_id: a.staff_id, start_date: a.start_date, end_date: a.end_date,
        request_type: a.kind, exclude_request_id: a.id, rules,
      });
      out.findings.push(...leave.findings);
      out.blocked = leave.blocked;
    }
    out.overrides = await svc.overridesFor(db, 'absence_request', a.id);
    out.warnings = out.findings.filter(f => f.status === 'warn' || f.status === 'block').length;
    res.json(out);
  } catch (e) {
    console.error('[employment-rules] absence:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /override — a manager going ahead anyway, with a reason ────────────
// The reason is NOT NULL in the table and required here: an override with no
// reason is exactly what this record exists to prevent.
router.post('/override', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const { rule_key, subject_kind, subject_id, staff_id, reason, rule_detail } = req.body || {};
  if (!rule_key || !subject_kind || !subject_id) {
    return res.status(400).json({ error: 'rule_key, subject_kind and subject_id are required' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A reason is required. An override with no reason is not a decision anyone can defend later.' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO ${SCHEMA()}.employment_rule_overrides
        (rule_key, subject_kind, subject_id, staff_id, reason, rule_detail, overridden_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [rule_key, subject_kind, Number(subject_id), staff_id ? Number(staff_id) : null,
       String(reason).trim(), rule_detail || null, req.user.id]);
    await recordAudit({
      req, action: 'update', entity_type: subject_kind, entity_id: Number(subject_id),
      meta: { employment_rule_override: rule_key, reason: String(reason).trim().slice(0, 300) },
    }).catch(() => {});
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /overrides — every time we went against our own rules ───────────────
router.get('/overrides', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT o.*, s.first_name || ' ' || s.last_name AS by_name,
             t.first_name || ' ' || t.last_name AS about_name,
             r.title AS rule_title, r.source_ref
        FROM ${SCHEMA()}.employment_rule_overrides o
        LEFT JOIN ${SCHEMA()}.staff s ON s.id = o.overridden_by
        LEFT JOIN ${SCHEMA()}.staff t ON t.id = o.staff_id
        LEFT JOIN ${SCHEMA()}.employment_rules r ON r.rule_key = o.rule_key
       ORDER BY o.created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /ssp/:absenceId — Statutory Sick Pay, from the law in force ─────────
// Pay data: manager, or the person it is about.
router.get('/ssp/:absenceId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, staff_id, start_date, end_date,
              COALESCE(request_type, absence_type, 'holiday') AS kind
         FROM ${SCHEMA()}.absence_requests WHERE id=$1`, [req.params.absenceId]);
    const a = rows[0];
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.staff_id !== req.user.id && !isManager(req)) return res.status(403).json({ error: 'Forbidden' });
    if (a.kind !== 'sick') return res.status(400).json({ error: 'That absence is not a sickness absence.' });
    const out = await svc.sspFor(db, a);
    out.absence_id = a.id;
    res.json(out);
  } catch (e) {
    console.error('[employment-rules] ssp:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /ssp/preview — what SSP would be for a hypothetical absence ────────
// Manager-only: it reads a salary. Used by the Roost screen to answer "what
// does a week off actually cost us now the waiting days are gone?".
router.post('/ssp/preview', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  if (!b.staff_id || !b.start_date) return res.status(400).json({ error: 'staff_id and start_date required' });
  try {
    const db = getPool();
    const out = await svc.sspFor(db, {
      staff_id: Number(b.staff_id),
      start_date: b.start_date,
      end_date: b.end_date || b.start_date,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /working-time/:weekStart — adult WTR warnings for a rota week ───────
// Under-18s are checked by GET /api/rota/week/:date/young-worker-warnings
// (b317), against tighter limits. Two endpoints on purpose, not one: mixing
// them would report an adult warning against a sixteen-year-old and understate
// the problem.
router.get('/working-time/:weekStart', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const ws = ER.mondayOf(req.params.weekStart);
  try {
    const db = getPool();
    const out = await svc.workingTimeForWeek(db, ws);
    out.young_worker_endpoint = `/api/rota/week/${ws}/young-worker-warnings`;
    res.json(out);
  } catch (e) {
    console.error('[employment-rules] working-time:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /staff/:id/dismissal-position ───────────────────────────────────────
// When this person's six-month point falls, and what changes on 1 Jan 2027.
// Manager-only, and about DATES — it offers no view on whether anybody should
// be dismissed.
router.get('/staff/:id/dismissal-position', async (req, res) => {
  const id = Number(req.params.id);
  if (id !== req.user.id && !isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const rules = await svc.loadRules(db, 'discipline');
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, contract_start FROM ${SCHEMA()}.staff WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const pos = ER.unfairDismissalPosition(rules, rows[0].contract_start, new Date());
    res.json({ staff_id: id, staff_name: `${rows[0].first_name} ${rows[0].last_name}`, ...pos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /dismissal-horizon — everyone, by when protection starts ────────────
// The list Toby actually needs: who is inside probation today and when each of
// them crosses the line, now that the line moves to six months on 1 Jan 2027.
router.get('/dismissal-horizon', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const rules = await svc.loadRules(db, 'discipline');
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, job_title, contract_start
         FROM ${SCHEMA()}.staff WHERE is_active = true ORDER BY contract_start DESC NULLS LAST`);
    const now = new Date();
    const out = rows.map(r => {
      const pos = ER.unfairDismissalPosition(rules, r.contract_start, now);
      return {
        staff_id: r.id, name: `${r.first_name} ${r.last_name}`, job_title: r.job_title,
        ...pos,
      };
    });
    const r = ER.ruleFor(rules, 'discipline.qualifying_period');
    res.json({
      count: out.length,
      not_yet_protected: out.filter(x => x.set && !x.qualifies_today).length,
      no_start_date: out.filter(x => !x.set).length,
      rule: r.rule, source: r.source, source_url: r.source_url,
      staff: out,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
