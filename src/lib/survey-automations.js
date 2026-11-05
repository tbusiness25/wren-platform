'use strict';
// Survey-sending automations (2026-07-28) — the 5 scheduled parent-survey sends,
// dispatched by src/routes/automations.js's executeAutomation() for kind='survey_send'.
// Each function is idempotent (safe to re-run / re-trigger from "Run now") and only
// ever INSERTs survey_invites + queues comms_email_queue rows — never sends email
// directly (the existing comms-email-queue-drain.js worker + Gmail transport does
// that, same pipeline every other survey invite already uses).
//
// Recipe → function map lives at the bottom (SURVEY_AUTOMATIONS).

const {
  createInviteAndQueue,
  runStarterInvites,
  runLeaverInvites,
  publicOrigin,
} = require('../../scripts/survey-auto-invites');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── Quarterly — parent-quarterly-survey, once a quarter, to all current families.
// Not a one-shot invite: template is permanent (always_available) so the normal
// (template_id,email) dedupe would only ever send ONE invite per family, ever.
// Instead dedupe on "already invited to this quarter" (sent_at within the current
// calendar quarter) so the same family gets a fresh invite each quarter it runs. ──
async function runQuarterlySend(pool) {
  const origin = publicOrigin();
  const { rows: tpl } = await pool.query(
    `SELECT * FROM survey_templates WHERE slug='parent-quarterly-survey' AND active=true LIMIT 1`
  );
  if (!tpl.length) return { created: 0, skipped: 0, candidates: 0, note: 'template not found/inactive' };
  const t = tpl[0];

  const { rows: parents } = await pool.query(`
    SELECT DISTINCT lower(trim(e)) AS email, child_id FROM (
      SELECT parent_1_email AS e, id AS child_id FROM children WHERE is_active=true AND is_demo=false AND parent_1_email IS NOT NULL AND parent_1_email != ''
      UNION ALL
      SELECT parent_2_email, id FROM children WHERE is_active=true AND is_demo=false AND parent_2_email IS NOT NULL AND parent_2_email != ''
    ) x WHERE lower(trim(e)) ~ '^[^@]+@[^@]+\\.[^@]+$'
  `);

  let created = 0, skipped = 0;
  for (const p of parents) {
    // Already invited THIS quarter? (quarter = 3-month block starting Jan/Apr/Jul/Oct)
    const { rows: existing } = await pool.query(
      `SELECT id FROM survey_invites
        WHERE template_id=$1 AND email=$2
          AND sent_at >= date_trunc('quarter', now())`,
      [t.id, p.email]
    );
    if (existing.length) { skipped++; continue; }
    // skipDedupe: we already checked "invited this quarter" above — the shared
    // helper's default all-time check would otherwise block every quarter after
    // the first for this permanent, recurring template.
    if (await createInviteAndQueue(pool, t, p.email, p.child_id, origin, { skipDedupe: true })) created++; else skipped++;
  }
  return { created, skipped, candidates: parents.length };
}

// ── Starter (~6 weeks after start_date) — thin wrapper for run-history/toggle UI.
async function runStarterSend(pool) {
  return runStarterInvites(pool);
}

// ── Leaver (~1 week before leave_date) — thin wrapper for run-history/toggle UI.
async function runLeaverSend(pool) {
  return runLeaverInvites(pool);
}

// ── Shared: year-scoped template lookup/creation for the two Feb "leaver
// intention" campaign templates. New row each academic year (slug carries the
// year) so re-running in a later year naturally re-invites everyone — the
// existing (template_id,email) dedupe only needs to hold WITHIN a year. ──────
async function ensureYearlyTemplate(pool, { slugBase, name, surveyType, description, questions }) {
  const year = new Date().getUTCFullYear();
  const slug = `${slugBase}-${year}`;
  await pool.query(
    `INSERT INTO survey_templates
       (name, slug, survey_type, description, questions, audience, anonymous, auto_trigger, always_available, active)
     VALUES ($1,$2,$3,$4,$5::jsonb,'parent',false,NULL,false,true)
     ON CONFLICT (slug) DO NOTHING`,
    [name.replace('{year}', String(year)), slug, surveyType, description, JSON.stringify(questions)]
  );
  const { rows } = await pool.query('SELECT * FROM survey_templates WHERE slug=$1', [slug]);
  return rows[0];
}

const LEAVER_INTENTION_QUESTIONS = [
  { id: 'q1', type: 'single_choice', required: true,
    label: "I know it's early, but is your child going to school / a new setting in September?",
    options: [
      'A) Definitely going to school / a new setting in September',
      'B) Undecided',
      'C) Staying with Your Nursery',
    ] },
  { id: 'email', type: 'email', label: 'Your email (optional — only if you\'d like a reply)', required: false },
];

const LEAVING_DATE_QUESTIONS = [
  { id: 'q1', type: 'text', required: true,
    label: "Please confirm your child's last day with us, as early as you can tell us (e.g. 15/07/{year})" },
  { id: 'q2', type: 'long_text', required: false, label: 'Anything else you\'d like us to know about the move?' },
  { id: 'email', type: 'email', label: 'Your email (optional — only if you\'d like a reply)', required: false },
];

// ── Leaver intention (end of Feb) — every family whose child will be 3+ by
// 1 Sept of the current year and hasn't already been given a leave_date. ──────
async function runLeaverIntentionSend(pool) {
  const origin = publicOrigin();
  const year = new Date().getUTCFullYear();
  const t = await ensureYearlyTemplate(pool, {
    slugBase: 'leaver-intention', name: `September {year} plans`,
    surveyType: 'parent_leaver_intention',
    description: `Just a heads up so we can plan places for September ${year} — no commitment needed yet.`,
    questions: LEAVER_INTENTION_QUESTIONS,
  });

  const { rows: kids } = await pool.query(
    `SELECT id AS child_id, parent_1_email, parent_2_email
       FROM children
      WHERE is_active=true AND is_demo=false AND leave_date IS NULL
        AND date_of_birth IS NOT NULL
        AND date_of_birth <= (make_date($1::int, 9, 1) - INTERVAL '3 years')`,
    [year]
  );
  let created = 0, skipped = 0;
  for (const k of kids) {
    for (const email of [k.parent_1_email, k.parent_2_email]) {
      if (!email || !EMAIL_RE.test(String(email).trim())) continue;
      if (await createInviteAndQueue(pool, t, email, k.child_id, origin)) created++; else skipped++;
    }
  }
  return { created, skipped, candidates: kids.length, template: t.slug };
}

// ── Leaving-date nudge (same end-of-Feb campaign) — families who already
// answered "A) definitely going" on THIS YEAR's intention survey but haven't
// given us a confirmed leave_date yet. On the very first run of the season
// this will typically be 0 (nobody's answered yet) — it's designed to be
// re-run (or left on a recurring schedule) so it catches respondents as their
// answers come in. ──────────────────────────────────────────────────────────
async function runLeavingDateNudgeSend(pool) {
  const origin = publicOrigin();
  const year = new Date().getUTCFullYear();
  const intentionSlug = `leaver-intention-${year}`;
  const nudgeT = await ensureYearlyTemplate(pool, {
    slugBase: 'leaving-date-confirm', name: `Confirm your child's last day — {year}`,
    surveyType: 'parent_leaving_date',
    description: 'Please help us plan by confirming your child\'s last day with us as early as you can.',
    questions: LEAVING_DATE_QUESTIONS,
  });

  const { rows: candidates } = await pool.query(
    `SELECT DISTINCT r.child_id, c.parent_1_email, c.parent_2_email
       FROM survey_responses r
       JOIN survey_templates it ON it.id = r.template_id
       JOIN children c ON c.id = r.child_id
      WHERE it.slug = $1
        AND r.responses->>'q1' LIKE 'A)%'
        AND c.leave_date IS NULL
        AND c.is_active = true AND c.is_demo = false`,
    [intentionSlug]
  );
  let created = 0, skipped = 0;
  for (const k of candidates) {
    for (const email of [k.parent_1_email, k.parent_2_email]) {
      if (!email || !EMAIL_RE.test(String(email).trim())) continue;
      if (await createInviteAndQueue(pool, nudgeT, email, k.child_id, origin)) created++; else skipped++;
    }
  }
  return { created, skipped, candidates: candidates.length, template: nudgeT.slug };
}

const SURVEY_AUTOMATIONS = {
  quarterly_survey_send: runQuarterlySend,
  starter_survey_send: runStarterSend,
  leaver_survey_send: runLeaverSend,
  leaver_intention_send: runLeaverIntentionSend,
  leaving_date_nudge_send: runLeavingDateNudgeSend,
};

async function runSurveyAutomation(pool, recipeKey) {
  const fn = SURVEY_AUTOMATIONS[recipeKey];
  if (!fn) throw new Error(`Unknown survey automation recipe_key: ${recipeKey}`);
  const r = await fn(pool);
  const bits = [`created ${r.created ?? 0}`];
  if (r.skipped != null) bits.push(`skipped ${r.skipped}`);
  if (r.candidates != null) bits.push(`of ${r.candidates} candidates`);
  return bits.join(' ');
}

module.exports = {
  SURVEY_AUTOMATIONS,
  runSurveyAutomation,
  runQuarterlySend,
  runStarterSend,
  runLeaverSend,
  runLeaverIntentionSend,
  runLeavingDateNudgeSend,
};
