'use strict';
const express     = require('express');
const router      = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const n8n         = require('../agent/n8n-bridge');

const ADMIN_ROLES = new Set(['manager', 'deputy_manager', 'admin']);

router.use(authenticate);

// ── GET /templates — all available templates for this edition ─────────────────
router.get('/templates', async (req, res) => {
  const db = getPool();
  const edition = req.query.edition || process.env.WREN_EDITION || 'eyfs';
  try {
    const { rows } = await db.query(`
      SELECT t.*, i.id AS instance_id, i.enabled
      FROM wren_workflow_templates t
      LEFT JOIN wren_workflow_instances i ON i.template_id = t.id
      WHERE t.edition @> $1::text[]
         OR t.edition = '{}'
      ORDER BY t.category, t.name
    `, [[edition]]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /templates/:id/enable — enable/disable for this school ───────────────
router.post('/templates/:id/enable', async (req, res) => {
  if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Admin only' });
  const db = getPool();
  const { enabled = true } = req.body;
  try {
    const { rows } = await db.query(`
      INSERT INTO wren_workflow_instances (template_id, school_schema, enabled)
      VALUES ($1, $2, $3)
      ON CONFLICT (template_id) DO UPDATE SET enabled = $3, updated_at = NOW()
      RETURNING *
    `, [req.params.id, process.env.PG_SCHEMA || 'ladn', enabled]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /execute/:templateId — manually trigger a workflow ───────────────────
router.post('/execute/:templateId', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [tmpl] } = await db.query(
      'SELECT * FROM wren_workflow_templates WHERE id=$1', [req.params.templateId]
    );
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    // Role check
    const allowed = tmpl.who_can_run === 'staff'
      || (tmpl.who_can_run === 'teacher' && ['teacher','room_leader','deputy_manager','manager'].includes(req.user?.role))
      || ADMIN_ROLES.has(req.user?.role);
    if (!allowed) return res.status(403).json({ error: 'Not permitted' });

    const execId = (await db.query(`
      INSERT INTO wren_workflow_executions
        (template_id, template_name, triggered_by, triggered_by_staff_id, status, payload)
      VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id
    `, [
      tmpl.id, tmpl.name,
      `manual:${req.user.id}`, req.user.id,
      JSON.stringify(req.body || {}),
    ])).rows[0].id;

    // Try to trigger via n8n webhook if workflow_json has a webhookPath
    let n8nResult = null;
    const webhookPath = tmpl.workflow_json?.webhookPath;
    if (webhookPath) {
      n8nResult = await n8n.triggerWebhook(webhookPath, {
        ...(req.body || {}), _wren_exec_id: execId, _triggered_by: req.user.id,
      }).catch(e => ({ ok: false, error: e.message }));
    }

    await db.query(`
      UPDATE wren_workflow_executions
      SET status=$1, n8n_execution_id=$2, result=$3, finished_at=NOW()
      WHERE id=$4
    `, [
      n8nResult?.ok !== false ? 'success' : 'failed',
      n8nResult?.n8nId || null,
      JSON.stringify(n8nResult || {}),
      execId,
    ]);

    // Audit log
    await db.query(`
      INSERT INTO n8n_audit (event_type, workflow_name, triggered_by, payload_summary)
      VALUES ('trigger', $1, $2, $3)
    `, [tmpl.name, `staff:${req.user.id}`, JSON.stringify({ exec_id: execId })]).catch(() => {});

    res.json({ ok: true, execId, n8nResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /executions — recent execution log ────────────────────────────────────
router.get('/executions', async (req, res) => {
  if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Admin only' });
  const db = getPool();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const { rows } = await db.query(`
      SELECT e.*, s.first_name || ' ' || s.last_name AS triggered_by_name
      FROM wren_workflow_executions e
      LEFT JOIN staff s ON s.id = e.triggered_by_staff_id
      ORDER BY e.started_at DESC LIMIT $1
    `, [limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /n8n/status — live n8n health + workflow list ────────────────────────
router.get('/n8n/status', async (req, res) => {
  if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Admin only' });
  const [healthy, workflows, executions] = await Promise.all([
    n8n.healthCheck(),
    n8n.listWorkflows(),
    n8n.listExecutions(null, 10),
  ]);
  res.json({ healthy, workflows, executions });
});

// ── POST /seed — create the 36 built-in templates ────────────────────────────
router.post('/seed', async (req, res) => {
  if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Admin only' });
  const db = getPool();
  try {
    await _seedTemplates(db);
    res.json({ ok: true, message: 'Templates seeded' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SHARED: template definitions ──────────────────────────────────────────────
async function _seedTemplates(db) {
  const templates = [
    // ── EYFS / Nursery ─────────────────────────────────────────────────────────
    {
      name: 'Large invoice trustee alert',
      description: 'When an invoice over £200 is raised, automatically email the trustee in CC.',
      edition: ['eyfs'],
      category: 'finance',
      trigger_type: 'event',
      trigger_config: { event: 'invoice.created', condition: 'amount > 200' },
      workflow_json: { webhookPath: 'wren/invoice-trustee-alert', description: 'Import this template into n8n Wren workspace' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Parent portal inactivity chase',
      description: "When a parent hasn't logged into the portal for 4 weeks, flag for a friendly follow-up call.",
      edition: ['eyfs'],
      category: 'communication',
      trigger_type: 'cron',
      trigger_config: { cron: '0 9 * * 1', description: 'Every Monday 9am' },
      workflow_json: { webhookPath: 'wren/parent-inactivity-check' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Three incidents in a week — notify SENCo & DSL',
      description: 'When a child has 3 or more incidents in a rolling 7-day window, notify SENCo and DSL.',
      edition: ['eyfs'],
      category: 'safeguarding',
      trigger_type: 'event',
      trigger_config: { event: 'incident.created' },
      workflow_json: { webhookPath: 'wren/incident-threshold-alert' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Absence rota-cover finder',
      description: 'When a staff member marks themselves absent, find and notify available cover from the rota.',
      edition: ['eyfs'],
      category: 'operations',
      trigger_type: 'event',
      trigger_config: { event: 'absence.created' },
      workflow_json: { webhookPath: 'wren/absence-cover-finder' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'New enquiry welcome email + tour offer',
      description: 'When a new enquiry is submitted, send a warm welcome email and offer a tour booking link.',
      edition: ['eyfs'],
      category: 'communication',
      trigger_type: 'event',
      trigger_config: { event: 'enquiry.created' },
      workflow_json: { webhookPath: 'wren/new-enquiry-welcome' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Overdue fees Stripe reminder',
      description: 'When fees are outstanding for more than 30 days, send a polite Stripe payment reminder.',
      edition: ['eyfs'],
      category: 'finance',
      trigger_type: 'cron',
      trigger_config: { cron: '0 10 * * 2', description: 'Every Tuesday 10am' },
      workflow_json: { webhookPath: 'wren/overdue-fees-reminder' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Trip consent signed → auto-invoice',
      description: 'When a parent signs a trip permission slip, generate and send the Wren Pay invoice.',
      edition: ['eyfs'],
      category: 'finance',
      trigger_type: 'event',
      trigger_config: { event: 'permission_slip.signed' },
      workflow_json: { webhookPath: 'wren/trip-consent-invoice' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Mandatory training expiry alert',
      description: 'When any mandatory training is within 30 days of expiry, alert the manager.',
      edition: ['eyfs'],
      category: 'operations',
      trigger_type: 'cron',
      trigger_config: { cron: '0 8 * * 1', description: 'Every Monday 8am' },
      workflow_json: { webhookPath: 'wren/training-expiry-alert' },
      who_can_run: 'admin',
      audit_required: false,
    },
    {
      name: 'Low attendance alert',
      description: "When a child's attendance drops below 90% in any fortnight, alert the manager.",
      edition: ['eyfs'],
      category: 'safeguarding',
      trigger_type: 'cron',
      trigger_config: { cron: '0 7 * * 5', description: 'Every Friday 7am' },
      workflow_json: { webhookPath: 'wren/low-attendance-alert' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Daily 6pm: publish today\'s photos',
      description: "Every evening at 6pm, post the day's approved photos to parent portals.",
      edition: ['eyfs'],
      category: 'communication',
      trigger_type: 'cron',
      trigger_config: { cron: '0 18 * * 1-5', description: 'Weekdays 6pm' },
      workflow_json: { webhookPath: 'wren/daily-photos-publish' },
      who_can_run: 'admin',
      audit_required: false,
    },
    {
      name: 'Weekly Friday: newsletter draft',
      description: "Every Friday afternoon, generate an AI draft newsletter from the week's observations and activities.",
      edition: ['eyfs'],
      category: 'communication',
      trigger_type: 'cron',
      trigger_config: { cron: '0 14 * * 5', description: 'Fridays 2pm' },
      workflow_json: { webhookPath: 'wren/weekly-newsletter-draft' },
      who_can_run: 'admin',
      audit_required: false,
    },
    {
      name: 'Ratio risk — Telegram manager alert',
      description: 'When Wren Insights detects a ratio risk (staffing below statutory minimum), Telegram-alert the manager instantly.',
      edition: ['eyfs'],
      category: 'operations',
      trigger_type: 'event',
      trigger_config: { event: 'insights.ratio_risk' },
      workflow_json: { webhookPath: 'wren/ratio-risk-telegram' },
      who_can_run: 'admin',
      audit_required: true,
    },

    // ── Primary ────────────────────────────────────────────────────────────────
    {
      name: 'Large invoice trustee alert',
      description: 'When an invoice over £200 is raised, automatically email the trustee in CC.',
      edition: ['primary'],
      category: 'finance',
      trigger_type: 'event',
      trigger_config: { event: 'invoice.created', condition: 'amount > 200' },
      workflow_json: { webhookPath: 'wren/invoice-trustee-alert' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Parent portal inactivity chase',
      description: "When a parent hasn't logged into the portal for 4 weeks, flag for a follow-up.",
      edition: ['primary'],
      category: 'communication',
      trigger_type: 'cron',
      trigger_config: { cron: '0 9 * * 1' },
      workflow_json: { webhookPath: 'wren/parent-inactivity-check' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Overdue fees Stripe reminder',
      description: 'When school fees are outstanding for more than 30 days, send a payment reminder.',
      edition: ['primary'],
      category: 'finance',
      trigger_type: 'cron',
      trigger_config: { cron: '0 10 * * 2' },
      workflow_json: { webhookPath: 'wren/overdue-fees-reminder' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Trip consent signed → auto-invoice',
      description: 'When a parent signs a trip permission slip, generate the Wren Pay invoice.',
      edition: ['primary'],
      category: 'finance',
      trigger_type: 'event',
      trigger_config: { event: 'permission_slip.signed' },
      workflow_json: { webhookPath: 'wren/trip-consent-invoice' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Mandatory training expiry alert',
      description: 'When mandatory training is within 30 days of expiry, alert the manager.',
      edition: ['primary'],
      category: 'operations',
      trigger_type: 'cron',
      trigger_config: { cron: '0 8 * * 1' },
      workflow_json: { webhookPath: 'wren/training-expiry-alert' },
      who_can_run: 'admin',
      audit_required: false,
    },
    {
      name: 'New enquiry welcome email + tour offer',
      description: 'When a new admissions enquiry arrives, send a welcome email and offer a tour.',
      edition: ['primary'],
      category: 'communication',
      trigger_type: 'event',
      trigger_config: { event: 'enquiry.created' },
      workflow_json: { webhookPath: 'wren/new-enquiry-welcome' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Absence rota-cover finder',
      description: 'When a teacher marks as absent, find and notify available cover.',
      edition: ['primary'],
      category: 'operations',
      trigger_type: 'event',
      trigger_config: { event: 'absence.created' },
      workflow_json: { webhookPath: 'wren/absence-cover-finder' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Pupil premium behaviour escalation',
      description: 'When a pupil premium child has a behaviour event, notify class teacher and SENCo.',
      edition: ['primary'],
      category: 'safeguarding',
      trigger_type: 'event',
      trigger_config: { event: 'behaviour.created', condition: 'pupil_premium=true' },
      workflow_json: { webhookPath: 'wren/pp-behaviour-alert' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Low attendance escalation — 2 weeks',
      description: "When a pupil's attendance is below 85% for two consecutive weeks, escalate to attendance officer.",
      edition: ['primary'],
      category: 'safeguarding',
      trigger_type: 'cron',
      trigger_config: { cron: '0 7 * * 5' },
      workflow_json: { webhookPath: 'wren/low-attendance-alert' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'SATs readiness alert — 60 days out',
      description: 'When the SATs window is 60 days away, check all readiness flags and alert the assessment lead.',
      edition: ['primary'],
      category: 'operations',
      trigger_type: 'cron',
      trigger_config: { cron: '0 8 1 * *', description: '1st of each month' },
      workflow_json: { webhookPath: 'wren/sats-readiness-check' },
      who_can_run: 'admin',
      audit_required: false,
    },
    {
      name: 'Y1 phonics screening reminder',
      description: 'When the Y1 phonics screening window approaches, alert each class teacher with their cohort data.',
      edition: ['primary'],
      category: 'operations',
      trigger_type: 'cron',
      trigger_config: { cron: '0 8 1 5 *', description: '1 May each year' },
      workflow_json: { webhookPath: 'wren/phonics-screening-reminder' },
      who_can_run: 'admin',
      audit_required: false,
    },

    // ── Secondary ──────────────────────────────────────────────────────────────
    {
      name: 'Large invoice trustee alert',
      description: 'When an invoice over £200 is raised, email the trustee in CC.',
      edition: ['secondary'],
      category: 'finance',
      trigger_type: 'event',
      trigger_config: { event: 'invoice.created', condition: 'amount > 200' },
      workflow_json: { webhookPath: 'wren/invoice-trustee-alert' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Parent portal inactivity chase',
      description: 'When a parent has not logged in for 4 weeks, flag for a follow-up.',
      edition: ['secondary'],
      category: 'communication',
      trigger_type: 'cron',
      trigger_config: { cron: '0 9 * * 1' },
      workflow_json: { webhookPath: 'wren/parent-inactivity-check' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Overdue fees Stripe reminder',
      description: 'When school fees (trips, lunch, etc.) are outstanding 30 days, send a reminder.',
      edition: ['secondary'],
      category: 'finance',
      trigger_type: 'cron',
      trigger_config: { cron: '0 10 * * 2' },
      workflow_json: { webhookPath: 'wren/overdue-fees-reminder' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Trip consent signed → auto-invoice',
      description: 'When a permission slip is signed, generate the payment invoice.',
      edition: ['secondary'],
      category: 'finance',
      trigger_type: 'event',
      trigger_config: { event: 'permission_slip.signed' },
      workflow_json: { webhookPath: 'wren/trip-consent-invoice' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Mandatory training expiry alert',
      description: 'When mandatory training is within 30 days of expiry, alert the manager.',
      edition: ['secondary'],
      category: 'operations',
      trigger_type: 'cron',
      trigger_config: { cron: '0 8 * * 1' },
      workflow_json: { webhookPath: 'wren/training-expiry-alert' },
      who_can_run: 'admin',
      audit_required: false,
    },
    {
      name: 'New admissions enquiry welcome',
      description: 'When a new admissions enquiry arrives, send a welcome email and offer a tour.',
      edition: ['secondary'],
      category: 'communication',
      trigger_type: 'event',
      trigger_config: { event: 'enquiry.created' },
      workflow_json: { webhookPath: 'wren/new-enquiry-welcome' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Absence cover finder',
      description: 'When a teacher is absent, find and notify available cover staff.',
      edition: ['secondary'],
      category: 'operations',
      trigger_type: 'event',
      trigger_config: { event: 'absence.created' },
      workflow_json: { webhookPath: 'wren/absence-cover-finder' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Detention not served — escalate to HOY',
      description: 'When a set detention has not been served within 48 hours, escalate to Head of Year.',
      edition: ['secondary'],
      category: 'operations',
      trigger_type: 'cron',
      trigger_config: { cron: '0 16 * * 1-5', description: 'Weekdays 4pm' },
      workflow_json: { webhookPath: 'wren/detention-escalate-hoy' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'GCSE underperformance alert',
      description: "When a pupil's predicted grade is 2+ grades below target, alert class teacher and form tutor.",
      edition: ['secondary'],
      category: 'safeguarding',
      trigger_type: 'cron',
      trigger_config: { cron: '0 7 * * 1', description: 'Every Monday 7am' },
      workflow_json: { webhookPath: 'wren/gcse-underperformance-alert' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'NEET risk flag — notify destinations lead',
      description: 'When a Y11 pupil is flagged as NEET risk, notify the destinations lead within 24 hours.',
      edition: ['secondary'],
      category: 'safeguarding',
      trigger_type: 'event',
      trigger_config: { event: 'neet_risk.flagged' },
      workflow_json: { webhookPath: 'wren/neet-risk-destinations' },
      who_can_run: 'admin',
      audit_required: true,
    },
    {
      name: 'Peer-on-peer safeguarding fast-escalation',
      description: 'When a safeguarding concern is categorised as peer-on-peer, immediately alert DSL and Senior Lead.',
      edition: ['secondary'],
      category: 'safeguarding',
      trigger_type: 'event',
      trigger_config: { event: 'safeguarding.created', condition: 'category=peer_on_peer' },
      workflow_json: { webhookPath: 'wren/peer-on-peer-escalation' },
      who_can_run: 'admin',
      audit_required: true,
    },
  ];

  for (const t of templates) {
    await db.query(`
      INSERT INTO wren_workflow_templates
        (name, description, edition, category, trigger_type, trigger_config,
         workflow_json, audit_required, who_can_run, who_can_edit, is_builtin, enabled_by_default)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'admin',true,false)
      ON CONFLICT DO NOTHING
    `, [
      t.name, t.description, t.edition, t.category, t.trigger_type,
      JSON.stringify(t.trigger_config || {}), JSON.stringify(t.workflow_json || {}),
      t.audit_required !== false, t.who_can_run || 'admin',
    ]);
  }
}

module.exports = router;
module.exports.seedTemplates = _seedTemplates;
