'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Wren Automations (2026-07-15, Toby) — simple "if this then that" for the jobs a
// nursery does every week/month: parent-detail reminders, funding reminders, staff
// task nudges, fire-drill prompts, "invoices are due" reminders, policy reads.
//
// Deliberately lightweight and SAFE by default — actions are in-app notifications
// and tasks (reversible, no money moved, no email/SMS sent without a person). The
// outward / money jobs (generate + send invoices, collect GoCardless) are shipped
// as REMINDERS that create a manager task to review-and-send, not blind auto-fires;
// they can be upgraded to fully-automatic later once trusted. This complements the
// existing n8n-backed /api/workflows (that one is for power users / custom flows).
//
// Table lives in the serving tenant schema (ladn / wren_dev / demo_*), lazily
// created & idempotent. Additive only.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const isManager = req => ['manager', 'deputy_manager', 'admin'].includes(req.user && req.user.role);

// ── Built-in recipes ──────────────────────────────────────────────────────────
// audience: who the reminder goes to. kind: notify | task. Money/outward jobs use
// kind:'task' targeted at managers ("review and send") — never an auto-send.
const RECIPES = [
  { key: 'parent_details_reminder', icon: '📇', name: 'Ask parents to check their details',
    desc: 'Posts an in-app reminder to all parents to review and update their contact & child details.',
    schedule: { freq: 'monthly', dom: 1, time: '09:00' }, kind: 'notify', audience: 'parents',
    title: 'Please check your details are up to date',
    body: 'Take a moment in your parent app to confirm your contact details, emergency contacts and your child’s information are correct. Tap Family to review.' },

  { key: 'funding_reminder', icon: '💷', name: 'Funding application reminder',
    desc: 'Reminds parents each term to apply for / reconfirm funded hours and 30-hour codes.',
    schedule: { freq: 'monthly', dom: 5, time: '09:00' }, kind: 'notify', audience: 'parents',
    title: 'Funding — apply or reconfirm your hours',
    body: 'If your child is eligible for funded hours (2-year, 15 or 30 hours), please apply or reconfirm your code before the deadline so we can claim it. Ask the office if you need help.' },

  { key: 'staff_task_reminder', icon: '✅', name: 'Nudge staff on outstanding tasks',
    desc: 'Weekly in-app nudge to staff who have open tasks.',
    schedule: { freq: 'weekly', dow: 1, time: '08:30' }, kind: 'notify', audience: 'staff',
    title: 'Your outstanding tasks', body: 'You have tasks still to do this week — open Tasks to see what’s outstanding.' },

  { key: 'fire_drill_reminder', icon: '🔥', name: 'Fire drill reminder',
    desc: 'Monthly prompt to managers to run a fire drill and record it.',
    schedule: { freq: 'monthly', dom: 1, time: '09:30' }, kind: 'task', audience: 'managers',
    title: 'Run this month’s fire drill', body: 'Carry out a fire drill and record it (date, time to evacuate, who was present, any issues).' },

  { key: 'invoices_due_reminder', icon: '🧾', name: 'Invoices due — review & send',
    desc: 'Monthly task for the manager to generate, check and send invoices (does NOT auto-send).',
    schedule: { freq: 'monthly', dom: 25, time: '09:00' }, kind: 'task', audience: 'managers',
    title: 'Generate & send this month’s invoices', body: 'Review the funding deductions, generate invoices in Finance, check them, then send. Collect GoCardless payments after sending.' },

  { key: 'policy_reading_reminder', icon: '📚', name: 'Policy reading reminder',
    desc: 'Reminds staff to read and sign any outstanding policies.',
    schedule: { freq: 'monthly', dom: 15, time: '08:30' }, kind: 'notify', audience: 'staff',
    title: 'Policies to read & sign', body: 'Please read and sign any outstanding policies in the app — check the Policies list.' },

  { key: 'weekly_task_digest', icon: '📋', name: 'Weekly outstanding-tasks digest (manager)',
    desc: 'Monday summary to managers of what’s still open.',
    schedule: { freq: 'weekly', dow: 1, time: '08:00' }, kind: 'notify', audience: 'managers',
    title: 'This week’s outstanding tasks', body: 'Here’s your reminder to review the open tasks board for the week ahead.' },

  // ── Survey sends (2026-07-28) — kind:'survey_send'. Unlike notify/task these
  // send a REAL email (magic-link survey invite) via the existing comms_email_queue
  // → comms-email-queue-drain.js → Gmail pipeline. Logic lives in
  // src/lib/survey-automations.js (recipient SQL + idempotent invite creation).
  { key: 'quarterly_survey_send', icon: '📊', name: 'Quarterly parent survey',
    desc: 'Emails the all-aspects Quarterly Family Survey to every current family, once a quarter.',
    schedule: { freq: 'quarterly', dom: 1, time: '08:00' }, kind: 'survey_send', audience: 'parents' },

  { key: 'starter_survey_send', icon: '🌱', name: 'New-starter settling-in survey',
    desc: 'Emails a family the settling-in survey about 6 weeks after their child\'s start date.',
    schedule: { freq: 'daily', time: '06:30' }, kind: 'survey_send', audience: 'parents' },

  { key: 'leaver_survey_send', icon: '🎓', name: 'Leaver feedback survey',
    desc: 'Emails the leaver survey about a week before a child\'s recorded leave date.',
    schedule: { freq: 'daily', time: '06:45' }, kind: 'survey_send', audience: 'parents' },

  { key: 'leaver_intention_send', icon: '🏫', name: 'September plans check (end of Feb)',
    desc: 'Asks every family whose child will be 3+ by 1 September whether they\'re moving on to school, undecided, or staying — for place planning.',
    schedule: { freq: 'yearly', month: 2, dom: 28, time: '08:00' }, kind: 'survey_send', audience: 'parents' },

  { key: 'leaving_date_nudge_send', icon: '📅', name: 'Confirm leaving date nudge',
    desc: 'For families who\'ve said they\'re moving on to school, asks them to confirm their child\'s last day as early as possible.',
    schedule: { freq: 'yearly', month: 2, dom: 28, time: '08:15' }, kind: 'survey_send', audience: 'parents' },
];
const RECIPE_BY_KEY = Object.fromEntries(RECIPES.map(r => [r.key, r]));
const FREQS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
const KINDS = ['notify', 'task', 'survey_send'];
const AUDIENCES = ['parents', 'staff', 'managers'];
const QUARTER_MONTHS = [0, 3, 6, 9]; // Jan/Apr/Jul/Oct (0-indexed) — fixed quarter starts

let _ensured = null;
function ensureTable() {
  if (_ensured) return _ensured;
  _ensured = getPool().query(`
    CREATE TABLE IF NOT EXISTS automations (
      id           SERIAL PRIMARY KEY,
      recipe_key   TEXT,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'notify',   -- notify | task
      audience     TEXT NOT NULL DEFAULT 'managers', -- parents | staff | managers
      title        TEXT NOT NULL,
      body         TEXT,
      schedule     JSONB NOT NULL DEFAULT '{}',      -- {freq,time,dow,dom}
      enabled      BOOLEAN NOT NULL DEFAULT true,
      last_run_at  TIMESTAMPTZ,
      next_run_at  TIMESTAMPTZ,
      last_result  TEXT,
      created_by   INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).then(() => true).catch(e => { _ensured = null; throw e; });
  return _ensured;
}
router.use((req, res, next) => { ensureTable().then(() => next()).catch(next); });

// ── Next-run computation (local Europe/London-ish; server is UTC, good enough for
// a daily-granularity scheduler) ─────────────────────────────────────────────────
function computeNextRun(schedule, from) {
  const s = schedule || {};
  const [hh, mm] = String(s.time || '09:00').split(':').map(n => parseInt(n, 10) || 0);
  const base = from ? new Date(from) : new Date();
  const next = new Date(base);
  next.setSeconds(0, 0);
  next.setHours(hh, mm, 0, 0);
  const freq = FREQS.includes(s.freq) ? s.freq : 'monthly';
  if (freq === 'daily') {
    if (next <= base) next.setDate(next.getDate() + 1);
  } else if (freq === 'weekly') {
    const dow = Number.isInteger(s.dow) ? s.dow : 1;   // 0=Sun..6=Sat
    while (next.getDay() !== dow || next <= base) next.setDate(next.getDate() + 1);
  } else if (freq === 'quarterly') {
    // Fixed quarter-start months (Jan/Apr/Jul/Oct) so "once a quarter" lands on a
    // predictable date rather than drifting +3 months from whenever it was created.
    const dom = Math.min(Math.max(parseInt(s.dom, 10) || 1, 1), 28);
    next.setDate(dom);
    let guard = 0;
    while ((!QUARTER_MONTHS.includes(next.getMonth()) || next <= base) && guard++ < 48) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(dom);
    }
  } else if (freq === 'yearly') {
    const dom = Math.min(Math.max(parseInt(s.dom, 10) || 1, 1), 28);
    const month = Math.min(Math.max(parseInt(s.month, 10) || 1, 1), 12) - 1; // 0-indexed
    next.setMonth(month, dom);
    if (next <= base) next.setFullYear(next.getFullYear() + 1, month, dom);
  } else { // monthly
    const dom = Math.min(Math.max(parseInt(s.dom, 10) || 1, 1), 28);
    next.setDate(dom);
    if (next <= base) { next.setMonth(next.getMonth() + 1); next.setDate(dom); }
  }
  return next;
}

// ── Action executor (used by this route's run-now AND the runner job) ──────────
// Safe primitives only: post in-app notifications, or create a task. Returns a
// short human summary string for last_result.
async function executeAutomation(pool, a) {
  const title = a.title || a.name;
  const body = a.body || '';
  if (a.kind === 'survey_send') {
    const { runSurveyAutomation } = require('../lib/survey-automations');
    return runSurveyAutomation(pool, a.recipe_key);
  }
  if (a.kind === 'task') {
    // A task for the managers to action (used for money/outward jobs — never auto-send).
    const { rows: [mgr] } = await pool.query(
      "SELECT id FROM staff WHERE is_active AND role IN ('manager','deputy_manager') ORDER BY id LIMIT 1")
      .catch(() => ({ rows: [] }));
    await pool.query(
      `INSERT INTO tasks (title, description, status, priority, owner_staff_id, created_at)
       VALUES ($1,$2,'open','medium',$3, now())`,
      [title, body, mgr ? mgr.id : null]).catch(async () => {
        // tasks schema variance — fall back to a manager notification
        await notifyAudience(pool, 'managers', title, body);
      });
    return 'created task';
  }
  // notify
  const n = await notifyAudience(pool, a.audience, title, body);
  return `notified ${n} ${a.audience}`;
}

async function notifyAudience(pool, audience, title, body) {
  let recipients = [];
  if (audience === 'parents') {
    const { rows } = await pool.query(
      "SELECT DISTINCT id FROM children WHERE is_active").catch(() => ({ rows: [] }));
    // parent notifications are keyed by child in this system
    recipients = rows.map(r => ({ type: 'parent', id: r.id }));
  } else if (audience === 'staff') {
    const { rows } = await pool.query("SELECT id FROM staff WHERE is_active").catch(() => ({ rows: [] }));
    recipients = rows.map(r => ({ type: 'staff', id: r.id }));
  } else { // managers
    const { rows } = await pool.query(
      "SELECT id FROM staff WHERE is_active AND role IN ('manager','deputy_manager')").catch(() => ({ rows: [] }));
    recipients = rows.map(r => ({ type: 'staff', id: r.id }));
  }
  let n = 0;
  for (const r of recipients) {
    await pool.query(
      `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, priority)
       VALUES ($1,$2,'automation',$3,$4,'normal')`,
      [r.type, r.id, title, body]).then(() => n++).catch(() => {});
  }
  return n;
}

// ── Routes ────────────────────────────────────────────────────────────────────
router.get('/recipes', (req, res) => res.json(RECIPES));

router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM automations ORDER BY enabled DESC, name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create — from a recipe (recipe_key) or a fully custom automation.
router.post('/', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const b = req.body || {};
    let base = {};
    if (b.recipe_key && RECIPE_BY_KEY[b.recipe_key]) {
      const r = RECIPE_BY_KEY[b.recipe_key];
      base = { recipe_key: r.key, name: r.name, kind: r.kind, audience: r.audience,
               title: r.title, body: r.body, schedule: r.schedule };
    }
    const name = b.name || base.name;
    if (!name) return res.status(400).json({ error: 'name required' });
    const kind = KINDS.includes(b.kind) ? b.kind : (base.kind || 'notify');
    const audience = AUDIENCES.includes(b.audience) ? b.audience : (base.audience || 'managers');
    const schedule = b.schedule || base.schedule || { freq: 'monthly', dom: 1, time: '09:00' };
    const title = b.title || base.title || name;
    const next = computeNextRun(schedule);
    const { rows: [row] } = await getPool().query(
      `INSERT INTO automations (recipe_key, name, kind, audience, title, body, schedule, enabled, next_run_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [base.recipe_key || null, name, kind, audience, title, b.body || base.body || null,
       JSON.stringify(schedule), b.enabled !== false, next, req.user.id]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const b = req.body || {};
    const sets = []; const args = [];
    const set = (c, v) => { args.push(v); sets.push(`${c}=$${args.length}`); };
    if (b.name !== undefined) set('name', b.name);
    if (b.enabled !== undefined) set('enabled', !!b.enabled);
    if (b.title !== undefined) set('title', b.title);
    if (b.body !== undefined) set('body', b.body);
    if (b.audience !== undefined && AUDIENCES.includes(b.audience)) set('audience', b.audience);
    if (b.kind !== undefined && KINDS.includes(b.kind)) set('kind', b.kind);
    if (b.schedule !== undefined) { set('schedule', JSON.stringify(b.schedule)); set('next_run_at', computeNextRun(b.schedule)); }
    else if (b.enabled === true) {
      // Turning on/resuming without a schedule change — (re)compute next_run_at if
      // it's missing or already in the past (e.g. pre-registered disabled recipes,
      // or an automation paused for a long time) so it fires on schedule, not
      // immediately and not never.
      const { rows: cur } = await getPool().query('SELECT schedule, next_run_at FROM automations WHERE id=$1', [req.params.id]);
      if (cur.length && (!cur[0].next_run_at || new Date(cur[0].next_run_at) <= new Date())) {
        set('next_run_at', computeNextRun(cur[0].schedule || {}));
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=now()');
    args.push(req.params.id);
    const { rows: [row] } = await getPool().query(
      `UPDATE automations SET ${sets.join(',')} WHERE id=$${args.length} RETURNING *`, args);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    await getPool().query('DELETE FROM automations WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Run now (manual trigger) — useful for testing + the "do it now" button.
router.post('/:id/run', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const pool = getPool();
    const { rows: [a] } = await pool.query('SELECT * FROM automations WHERE id=$1', [req.params.id]);
    if (!a) return res.status(404).json({ error: 'not found' });
    const result = await executeAutomation(pool, a);
    await pool.query('UPDATE automations SET last_run_at=now(), last_result=$2 WHERE id=$1', [a.id, result]);
    await recordRun(pool, a.id, result);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Run history (b151) — automations table only ever kept last_run_at/last_result
// (overwritten each run); automation_runs is a real per-run log so the UI can
// show a history list, not just "last run".
async function recordRun(pool, automationId, result) {
  const ok = !/^error/i.test(String(result || ''));
  await pool.query(
    'INSERT INTO automation_runs (automation_id, result, ok) VALUES ($1,$2,$3)',
    [automationId, result, ok]).catch(e => console.error('[automations] recordRun failed:', e.message));
}

router.get('/:id/runs', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT id, ran_at, result, ok FROM automation_runs WHERE automation_id=$1 ORDER BY ran_at DESC LIMIT 20',
      [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.executeAutomation = executeAutomation;
router.computeNextRun = computeNextRun;
router.recordRun = recordRun;
router.RECIPES = RECIPES;
module.exports = router;
