// ═══════════════════════════════════════════════════════════════════════════
// b279 — /api/email-rules (2026-09-04)
//
// The manager-facing CRUD for the email routing rules evaluated by
// src/services/email-rules.js on the existing Gmail poll.
//
// Gated on the `comms.email-rules` capability at 'manage' for every write and
// 'view' for every read. Owners and floor managers already resolve to 'manage'
// in src/lib/capabilities.js, so today that means Toby, the office manager, the business manager, the deputy,
// a practitioner and the room leader — and the Permissions screen can widen it without a deploy.
//
// GDPR: no endpoint in this file returns an email body, subject or address.
// /runs returns rule ids, message ids, decisions and action outcomes. The Test
// endpoint takes a FIXTURE the manager types, or a stored queue row, evaluates
// it and returns match/no-match — it never runs an action.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const express = require('express');
const router  = express.Router();

const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireCapabilityLevel } = require('../lib/capabilities');
const engine = require('../services/email-rules');

router.use(authenticate);

// Roost only. The EY portal has no business editing what gets forwarded off-site,
// and a parent token must never reach this router (it is on PARENT_DENY too).
router.use((req, res, next) => {
  if (req.user && req.user.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
  const portal = req._portal || 'admin';
  if (portal !== 'admin') return res.status(403).json({ error: 'Email rules are managed in Roost' });
  next();
});

const canRead  = requireCapabilityLevel('comms.email-rules', 'view');
const canWrite = requireCapabilityLevel('comms.email-rules', 'manage');

// ── Validation ─────────────────────────────────────────────────────────────
// A malformed rule is refused at the door rather than half-saved: an unknown
// condition type can never match (the engine returns false), so a typo would
// otherwise create a rule that silently does nothing forever.
function validateRule(body) {
  const errors = [];
  const name = String(body.name || '').trim();
  if (!name) errors.push('name is required');
  if (name.length > 120) errors.push('name is too long (120 max)');

  const mode = body.match_mode === 'any' ? 'any' : 'all';

  const conditions = Array.isArray(body.conditions) ? body.conditions : [];
  if (!conditions.length) errors.push('add at least one trigger — a rule with none matches nothing');
  conditions.forEach((c, i) => {
    const t = String(c?.type || '');
    const spec = engine.CONDITION_TYPES[t];
    if (!spec) { errors.push(`trigger ${i + 1}: unknown type "${t}"`); return; }
    const op = String(c?.op || spec.ops[0]);
    if (!spec.ops.includes(op)) errors.push(`trigger ${i + 1}: "${op}" is not valid for ${spec.label}`);
    const needsValue = !['has_attachment', 'contact'].includes(t);
    if (needsValue && !String(c?.value || '').trim()) errors.push(`trigger ${i + 1}: needs a value`);
    if (t === 'ai' && String(c?.value || '').length > 500) errors.push(`trigger ${i + 1}: criterion is too long (500 max)`);
  });

  const actions = Array.isArray(body.actions) ? body.actions : [];
  if (!actions.length) errors.push('add at least one action');
  actions.forEach((a, i) => {
    const t = String(a?.type || '');
    if (!engine.ACTION_TYPES[t]) { errors.push(`action ${i + 1}: unknown type "${t}"`); return; }
    if (t === 'forward' && !a.staff_id && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(a.to || '').trim())) {
      errors.push(`action ${i + 1}: forward needs a person or an email address`);
    }
    if (t === 'tag' && !String(a.tag || '').trim()) errors.push(`action ${i + 1}: tag needs a label`);
    if (t === 'set_topic' && !engine.TOPIC_VALUES.includes(String(a.topic || '').trim())) errors.push(`action ${i + 1}: choose a valid topic folder`);
    if (t === 'gmail_label' && !String(a.label || '').trim()) errors.push(`action ${i + 1}: Gmail label needs a name`);
    if (t === 'file_attachment' && !String(a.category || '').trim()) errors.push(`action ${i + 1}: choose a paperwork category`);
  });

  return {
    errors,
    clean: {
      name,
      description: String(body.description || '').trim().slice(0, 1000) || null,
      enabled: body.enabled !== false,
      priority: Number.isFinite(Number(body.priority)) ? Math.max(0, Math.min(9999, Number(body.priority))) : 100,
      stop_on_match: body.stop_on_match === true,
      match_mode: mode,
      conditions, actions,
    },
  };
}

/**
 * The half of validation that needs the database: a paperwork category has to
 * actually exist. Without this a typo saves happily and the rule then fails
 * silently at 3am for every email with an attachment — the engine refuses an
 * unknown category, but by then nobody is watching. Catch it at save time.
 */
async function validateAgainstDb(db, clean) {
  const errors = [];
  const cats = clean.actions
    .filter(a => a.type === 'file_attachment' && a.category)
    .map(a => a.category);
  if (cats.length) {
    const { rows } = await db.query(
      `SELECT key FROM paperwork_categories WHERE key = ANY($1::text[])`, [cats]);
    const known = new Set(rows.map(r => r.key));
    for (const c of cats) if (!known.has(c)) errors.push(`"${c}" is not a paperwork heading`);
  }
  const staffIds = clean.actions
    .filter(a => a.type === 'forward' && a.staff_id).map(a => Number(a.staff_id))
    .concat(clean.actions.filter(a => a.type === 'notify' && Array.isArray(a.staff_ids))
      .flatMap(a => a.staff_ids.map(Number)));
  if (staffIds.length) {
    const { rows } = await db.query(
      `SELECT id FROM staff WHERE id = ANY($1::int[]) AND is_active=true`, [staffIds]);
    const known = new Set(rows.map(r => r.id));
    for (const id of staffIds) if (!known.has(id)) errors.push(`staff ${id} is not an active member of staff`);
  }
  return errors;
}

// ── Meta: what the editor can offer ────────────────────────────────────────
router.get('/meta', canRead, async (req, res) => {
  const db = getPool();
  const out = {
    condition_types: engine.CONDITION_TYPES,
    action_types: engine.ACTION_TYPES,
    staff: [], paperwork_categories: [], tags: [],
  };
  try {
    const { rows } = await db.query(
      `SELECT id, first_name || ' ' || last_name AS name, email
         FROM staff WHERE is_active=true AND email IS NOT NULL AND email <> ''
        ORDER BY first_name`);
    out.staff = rows;
  } catch (_) {}
  try {
    const { rows } = await db.query(
      `SELECT key, label FROM paperwork_categories ORDER BY sort_order, key`);
    out.paperwork_categories = rows;
  } catch (_) {}
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT unnest(rule_tags) AS tag FROM comms_email_queue
        WHERE rule_tags <> '{}' ORDER BY 1 LIMIT 100`);
    out.tags = rows.map(r => r.tag);
  } catch (_) {}
  res.json(out);
});

// ── Health: is the AI trigger usable, and is it pointed somewhere local? ────
router.get('/health', canRead, async (req, res) => {
  try {
    const ai = await engine.aiHealth(getPool());
    const db = getPool();
    const { rows } = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE enabled)::int AS enabled,
              count(*) FILTER (WHERE enabled AND conditions @> '[{"type":"ai"}]')::int AS ai_rules
         FROM email_rules WHERE deleted=false`);
    res.json({ ai, rules: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── List, with the "is this rule still working?" columns ───────────────────
router.get('/', canRead, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.name, r.description, r.enabled, r.priority, r.stop_on_match,
             r.match_mode, r.conditions, r.actions,
             r.eval_count, r.match_count, r.evals_since_match,
             r.last_evaluated_at, r.last_matched_at, r.last_action_summary,
             r.last_error, r.last_error_at,
             r.created_at, r.updated_at,
             c.first_name || ' ' || c.last_name AS created_by_name,
             u.first_name || ' ' || u.last_name AS updated_by_name,
             (SELECT count(*)::int FROM email_rule_runs x
               WHERE x.rule_id = r.id AND x.created_at > now() - interval '30 days') AS runs_30d,
             (SELECT count(*)::int FROM email_rule_runs x
               WHERE x.rule_id = r.id AND x.matched AND x.created_at > now() - interval '30 days') AS matches_30d,
             (SELECT count(*)::int FROM email_rule_runs x
               WHERE x.rule_id = r.id AND x.decision='ai_unavailable'
                 AND x.created_at > now() - interval '7 days') AS ai_failures_7d
        FROM email_rules r
        LEFT JOIN staff c ON c.id = r.created_by
        LEFT JOIN staff u ON u.id = r.updated_by
       WHERE r.deleted = false
       ORDER BY r.priority ASC, r.id ASC`);
    res.json(rows);
  } catch (e) {
    console.error('[email-rules] list:', e.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Reorder ────────────────────────────────────────────────────────────────
// Order decides which rule sees a message first and whether stop_on_match ends
// the run, so it is a first-class edit rather than a hidden field.
// DECLARED BEFORE the :id routes on purpose: Express matches in declaration
// order, and the numeric :id guard below would 404 the literal path "order".
router.put('/order', canWrite, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids (array) required' });
  const db = getPool();
  try {
    for (let i = 0; i < ids.length; i++) {
      await db.query(`UPDATE email_rules SET priority=$2, updated_by=$3, updated_at=now()
                       WHERE id=$1 AND deleted=false`, [ids[i], (i + 1) * 10, req.user.id]);
    }
    res.json({ ok: true, ordered: ids.length });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'Not found' });
  next();
});

router.get('/:id', canRead, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT * FROM email_rules WHERE id=$1 AND deleted=false`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ── Recent activity for one rule ───────────────────────────────────────────
// No email content by construction — the table has no column for any.
router.get('/:id/runs', canRead, async (req, res) => {
  const db = getPool();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    const { rows } = await db.query(
      `SELECT id, message_id, matched, decision, matched_conditions, actions,
              ai_used, ai_host, duration_ms, error, created_at
         FROM email_rule_runs WHERE rule_id=$1
        ORDER BY created_at DESC LIMIT $2`, [req.params.id, limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ── Create ─────────────────────────────────────────────────────────────────
router.post('/', canWrite, async (req, res) => {
  const { errors, clean } = validateRule(req.body || {});
  if (errors.length) return res.status(400).json({ error: 'invalid_rule', errors });
  const db = getPool();
  try {
    const dbErrors = await validateAgainstDb(db, clean);
    if (dbErrors.length) return res.status(400).json({ error: 'invalid_rule', errors: dbErrors });
    const { rows } = await db.query(
      `INSERT INTO email_rules
         (name, description, enabled, priority, stop_on_match, match_mode, conditions, actions, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$9) RETURNING *`,
      [clean.name, clean.description, clean.enabled, clean.priority, clean.stop_on_match,
       clean.match_mode, JSON.stringify(clean.conditions), JSON.stringify(clean.actions), req.user.id]);
    console.log(`[email-rules] rule ${rows[0].id} created by staff ${req.user.id}`);
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[email-rules] create:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Update ─────────────────────────────────────────────────────────────────
router.put('/:id', canWrite, async (req, res) => {
  const { errors, clean } = validateRule(req.body || {});
  if (errors.length) return res.status(400).json({ error: 'invalid_rule', errors });
  const db = getPool();
  try {
    const dbErrors = await validateAgainstDb(db, clean);
    if (dbErrors.length) return res.status(400).json({ error: 'invalid_rule', errors: dbErrors });
    const { rows } = await db.query(
      `UPDATE email_rules
          SET name=$2, description=$3, enabled=$4, priority=$5, stop_on_match=$6,
              match_mode=$7, conditions=$8::jsonb, actions=$9::jsonb,
              updated_by=$10, updated_at=now(),
              -- editing a rule clears its last error: the next evaluation is the
              -- one that matters, and a stale error reads as a live fault.
              last_error=NULL, last_error_at=NULL
        WHERE id=$1 AND deleted=false RETURNING *`,
      [req.params.id, clean.name, clean.description, clean.enabled, clean.priority,
       clean.stop_on_match, clean.match_mode, JSON.stringify(clean.conditions),
       JSON.stringify(clean.actions), req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    console.log(`[email-rules] rule ${req.params.id} updated by staff ${req.user.id}`);
    res.json(rows[0]);
  } catch (e) {
    console.error('[email-rules] update:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── The on/off switch ──────────────────────────────────────────────────────
router.patch('/:id/enabled', canWrite, async (req, res) => {
  const enabled = req.body?.enabled === true;
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE email_rules SET enabled=$2, updated_by=$3, updated_at=now()
        WHERE id=$1 AND deleted=false RETURNING id, name, enabled`,
      [req.params.id, enabled, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    console.log(`[email-rules] rule ${req.params.id} ${enabled ? 'enabled' : 'disabled'} by staff ${req.user.id}`);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ── Delete (soft) ──────────────────────────────────────────────────────────
// Soft, so the evaluation history a deleted rule produced stays readable and
// nothing is removed from a table by an API call.
router.delete('/:id', canWrite, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE email_rules SET deleted=true, deleted_at=now(), deleted_by=$2, enabled=false
        WHERE id=$1 AND deleted=false RETURNING id`, [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    console.log(`[email-rules] rule ${req.params.id} deleted by staff ${req.user.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ── Test ───────────────────────────────────────────────────────────────────
// Evaluate a rule (saved or unsaved) against a fixture the manager types, or
// against the last N messages already in the queue. NEVER runs an action, and
// never writes a run row — a test must not look like a live firing in the log.
router.post('/test', canWrite, async (req, res) => {
  const db = getPool();
  const body = req.body || {};
  const { errors, clean } = validateRule(body.rule || {});
  if (errors.length) return res.status(400).json({ error: 'invalid_rule', errors });

  let messages = [];
  if (body.sample) {
    messages = [{
      messageId: 'test-fixture',
      fromEmail: String(body.sample.from || '').toLowerCase(),
      fromName:  String(body.sample.from_name || ''),
      subject:   String(body.sample.subject || ''),
      bodyText:  String(body.sample.body || ''),
      attachments: (body.sample.attachments || []).map(f => ({ filename: String(f), mimeType: '', size: 0 })),
      receivedAt: null,
    }];
  } else {
    const limit = Math.min(25, Math.max(1, parseInt(body.limit, 10) || 10));
    const { rows } = await db.query(
      `SELECT message_id, from_email, from_name, subject, body_text, snippet, received_at
         FROM comms_email_queue WHERE direction='in'
        ORDER BY received_at DESC LIMIT $1`, [limit]);
    messages = rows.map(r => ({
      messageId: r.message_id, fromEmail: r.from_email, fromName: r.from_name,
      subject: r.subject, bodyText: r.body_text || r.snippet, attachments: [],
      receivedAt: r.received_at,
    }));
  }

  const rule = { id: 0, ...clean, created_by: req.user.id };
  const out = [];
  for (const msg of messages) {
    try {
      const v = await engine.evaluateRule(db, rule, msg);
      out.push({ message_id: msg.messageId, matched: v.matched,
                 matched_conditions: v.matchedConditions, ai_used: v.aiUsed });
    } catch (e) {
      out.push({ message_id: msg.messageId, matched: false,
                 error: engine.redact(e.message), decision: e.code || 'error' });
    }
  }
  // Counts and match flags only — the tested messages' content never comes back
  // out of this endpoint, even to the manager who owns the mailbox.
  res.json({ tested: out.length, matched: out.filter(o => o.matched).length, results: out });
});

// ── Recent activity across every rule ──────────────────────────────────────
router.get('/activity/recent', canRead, async (req, res) => {
  const db = getPool();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    const { rows } = await db.query(
      `SELECT x.id, x.rule_id, r.name AS rule_name, x.message_id, x.matched, x.decision,
              x.actions, x.ai_used, x.duration_ms, x.error, x.created_at
         FROM email_rule_runs x JOIN email_rules r ON r.id = x.rule_id
        ORDER BY x.created_at DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

module.exports = router;
