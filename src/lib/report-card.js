'use strict';
/**
 * report-card.js — b187 (2026-08-19) — Setting Report Card scoring engine.
 *
 * ONE place that turns the data Wren already holds into an INTERNAL READINESS
 * INDICATOR across the four Ofsted EY inspection areas. It is deliberately NOT
 * an Ofsted grade and must never be presented as one — see HONESTY below.
 *
 * Nothing here polls the outside world. Statutory-change watching is already
 * done by the legislation-watch cron behind src/routes/regulatory.js; this file
 * only reads local records (observations, tracker, attendance, staff vetting,
 * supervisions, policies, risk assessments, headcounts, SEN, CPD).
 *
 * ── HONESTY ────────────────────────────────────────────────────────────────
 * 1. No sub-metric is invented from a source that does not exist. If the source
 *    table is missing, has never been used (zero rows ever), or the metric's
 *    denominator is zero, the sub-metric is returned with score === null and a
 *    `no_data` reason. A null-scored sub-metric is EXCLUDED from its domain
 *    average — it is never silently treated as 0 or as 100.
 * 2. A genuine measured zero (denominator > 0, numerator 0) IS scored 0. The
 *    distinction is: "we have nothing to measure with" vs "we measured, it's
 *    bad". Only the first is excluded.
 * 3. Every sub-metric carries numerator, denominator, the source tables it read
 *    and a `link` to the page that fixes it, so a score can always be taken
 *    apart and checked against the rows behind it.
 *
 * Weights are relative within a domain only — a domain score is the weighted
 * mean of its SCORED sub-metrics, so excluding a "no data" one re-normalises
 * the rest rather than dragging the domain down.
 */

const DOMAINS = [
  { key: 'quality_of_education',      label: 'Quality of education',       icon: '📚',
    blurb: 'Observation volume and quality, framework coverage, planning, next steps actioned.' },
  { key: 'behaviour_and_attitudes',   label: 'Behaviour and attitudes',    icon: '🧸',
    blurb: 'Attendance, register completeness, key-person coverage, settling records.' },
  { key: 'personal_development',      label: 'Personal development',       icon: '🌱',
    blurb: 'SEN reviews on time, CPD completion, staff knowledge checks.' },
  { key: 'leadership_and_management', label: 'Leadership and management',  icon: '🧭',
    blurb: 'Safeguarding training, DBS/RTW currency, supervisions, policies, risk assessments, ratios, Ofsted notifications.' },
];

const DOMAIN_KEYS = DOMAINS.map(d => d.key);

// RAG bands for both the overall indicator and each domain card.
const DEFAULT_GREEN = 80;
const DEFAULT_AMBER = 60;

// A domain scored from less than this share of its intended weight is reported
// with low_confidence: the number is real, but it rests on too little to lean on.
const LOW_CONFIDENCE_COVERAGE = 50;

const DISCLAIMER =
  'Internal readiness indicator — not an Ofsted grade. Wren does not predict, ' +
  'simulate or award an Ofsted judgement. This score is calculated only from ' +
  'records held in this setting and is intended to show where to look next.';

/* ── small helpers ─────────────────────────────────────────────────────────── */

const clamp = n => Math.max(0, Math.min(100, n));
const round1 = n => Math.round(n * 10) / 10;

async function getSetting(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (rows.length && rows[0].value != null && rows[0].value !== '') return rows[0].value;
  } catch (_) { /* settings unavailable — use the default */ }
  return fallback;
}
async function getNumSetting(db, key, fallback) {
  const n = parseFloat(await getSetting(db, key, String(fallback)));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Total rows ever in a table. null = table does not exist on this edition. */
async function tableRowCount(db, table) {
  try {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n;
  } catch (_) { return null; }
}

/** Result shape for "n out of d, as a percentage". */
function share(num, den, extra) {
  return Object.assign({
    score: clamp(Math.round((num / den) * 100)),
    value: round1((num / den) * 100),
    unit: '%',
    numerator: num,
    denominator: den,
  }, extra || {});
}

/** Result shape for "n against a local target" (score caps at 100). */
function againstTarget(actual, target, extra) {
  return Object.assign({
    score: clamp(Math.round((actual / target) * 100)),
    value: round1(actual),
    unit: '',
    numerator: actual,
    denominator: target,
  }, extra || {});
}

const noData = reason => ({ score: null, no_data: reason });

/**
 * b183 effort-weighted observation identity. A group observation writes one row
 * per child sharing a group_uuid, so the honest count of practitioner effort is
 * COUNT(DISTINCT group_uuid) — not COUNT(*). Rows written before b183 have a
 * NULL group_uuid, which DISTINCT would drop entirely, so those fall back to
 * their own id and still count once each.
 */
const OBS_EFFORT_KEY = `COALESCE(o.group_uuid::text, 'row:' || o.id)`;

/* ── sub-metric definitions ────────────────────────────────────────────────── */
/*
 * Each: { key, domain, label, weight, link, why, run(ctx) }
 *   run() resolves to either noData('reason') or a scored result. Any throw is
 *   caught by scoreAll() and becomes a no_data sub-metric, so one broken source
 *   costs one sub-metric, never the whole report card.
 */

const METRICS = [

  /* ══════════ QUALITY OF EDUCATION ══════════ */
  {
    key: 'qe_obs_coverage', domain: 'quality_of_education', weight: 3,
    label: 'Children observed in the last 30 days',
    why: 'Every child should have recent recorded learning. Children with nothing on file for a month are the ones an inspector finds.',
    link: '/observations.html',
    sources: ['children', 'observations'],
    async run(ctx) {
      if (ctx.counts.children === 0) return noData('No children on roll.');
      if (ctx.counts.observations === 0) return noData('No observations have ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE seen)::int AS num
          FROM (SELECT c.id,
                       EXISTS (SELECT 1 FROM observations o
                                WHERE o.child_id = c.id
                                  AND o.created_at >= current_date - 30) AS seen
                  FROM children c WHERE c.is_active = true AND COALESCE(c.is_demo, false) = false) t`);
      const { den, num } = rows[0];
      if (!den) return noData('No active children on roll.');
      return share(num, den, { detail: `${num} of ${den} active children have an observation in the last 30 days.` });
    },
  },
  {
    key: 'qe_obs_volume', domain: 'quality_of_education', weight: 2,
    label: 'Observation volume against target',
    why: 'Measured effort-weighted (b183): a group observation counts once, not once per child.',
    link: '/observations.html',
    sources: ['observations', 'children', 'settings.obs_target_per_child_term'],
    async run(ctx) {
      if (ctx.counts.observations === 0) return noData('No observations have ever been recorded.');
      const { rows: kids } = await ctx.db.query(
        'SELECT count(*)::int AS n FROM children WHERE is_active = true AND COALESCE(is_demo, false) = false');
      if (!kids[0].n) return noData('No active children on roll — nothing to set a target against.');
      const perChild = await getNumSetting(ctx.db, 'obs_target_per_child_term', 12);
      if (!perChild) return noData('Termly observation target (settings.obs_target_per_child_term) is not set.');
      const target = perChild * kids[0].n;
      const { rows } = await ctx.db.query(`
        SELECT count(DISTINCT ${OBS_EFFORT_KEY})::int AS n
          FROM observations o WHERE o.created_at >= current_date - 90`);
      return againstTarget(rows[0].n, target, {
        unit: ' observations',
        detail: `${rows[0].n} effort-weighted observations in the last 90 days against a target of ${target} ` +
                `(${perChild} per child per term × ${kids[0].n} children).`,
      });
    },
  },
  {
    key: 'qe_obs_next_steps', domain: 'quality_of_education', weight: 2,
    label: 'Observations carrying next steps',
    why: 'An observation without a next step records what happened but does not move learning on.',
    link: '/observations.html',
    sources: ['observations'],
    async run(ctx) {
      const g = await ctx.obsGroups();
      if (!g.den) return noData('No observations recorded in the last 90 days.');
      return share(g.ns, g.den, { detail: `${g.ns} of ${g.den} observations in the last 90 days record a next step.` });
    },
  },
  {
    key: 'qe_framework_linked', domain: 'quality_of_education', weight: 2,
    label: 'Observations linked to framework statements',
    why: 'Linked observations are what turn the tracker into evidence of curriculum coverage.',
    link: '/observations.html',
    sources: ['observations'],
    async run(ctx) {
      const g = await ctx.obsGroups();
      if (!g.den) return noData('No observations recorded in the last 90 days.');
      return share(g.fw, g.den, { detail: `${g.fw} of ${g.den} observations in the last 90 days link to at least one framework statement.` });
    },
  },
  {
    key: 'qe_framework_coverage', domain: 'quality_of_education', weight: 2,
    label: 'Children with framework tracker assessed',
    why: 'A child with no assessed statements has no recorded picture of where they are.',
    // fledge-off (2026-10-26): was /fledge-framework.html, which is hidden while Fledge
    // is off. The tracker is what this check is about, in either state.
    link: '/framework-tracker.html',
    sources: ['children', 'framework_tracker'],
    async run(ctx) {
      if (ctx.counts.framework_tracker === 0) return noData('The framework tracker has never been used.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE seen)::int AS num
          FROM (SELECT c.id,
                       EXISTS (SELECT 1 FROM framework_tracker ft
                                WHERE ft.child_id = c.id
                                  AND coalesce(ft.status, 'not_yet') <> 'not_yet') AS seen
                  FROM children c WHERE c.is_active = true AND COALESCE(c.is_demo, false) = false) t`);
      const { den, num } = rows[0];
      if (!den) return noData('No active children on roll.');
      return share(num, den, { detail: `${num} of ${den} active children have at least one assessed framework statement.` });
    },
  },
  {
    key: 'qe_planning', domain: 'quality_of_education', weight: 2,
    label: 'Rooms with a plan for this week',
    why: 'Planning on file is the first thing asked for when an inspector looks at intent.',
    link: '/planning.html',
    sources: ['rooms', 'weekly_plans'],
    async run(ctx) {
      if (ctx.counts.weekly_plans === null) return noData('Weekly planning is not available on this edition.');
      if (ctx.counts.weekly_plans === 0) return noData('No weekly plan has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE planned)::int AS num
          FROM (SELECT r.id,
                       EXISTS (SELECT 1 FROM weekly_plans wp
                                WHERE wp.room_id = r.id
                                  AND wp.week_commencing >= date_trunc('week', current_date)::date) AS planned
                  FROM rooms r) t`);
      const { den, num } = rows[0];
      if (!den) return noData('No rooms are configured.');
      return share(num, den, { detail: `${num} of ${den} rooms have a plan for the current week.` });
    },
  },
  {
    key: 'qe_next_steps_actioned', domain: 'quality_of_education', weight: 2,
    label: 'Next steps actioned',
    why: 'Next steps left open for more than a month are intent that never became practice.',
    link: '/planning.html',
    sources: ['next_steps'],
    async run(ctx) {
      if (ctx.counts.next_steps === null) return noData('Next steps are not available on this edition.');
      if (ctx.counts.next_steps === 0) return noData('No next steps have ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE coalesce(status,'open') IN ('completed','complete','achieved','done')
                                   OR completed_observation_id IS NOT NULL)::int AS num
          FROM next_steps
         WHERE created_at < current_date - 30`);
      const { den, num } = rows[0];
      if (!den) return noData('No next steps are older than 30 days yet — nothing has had time to be actioned.');
      return share(num, den, { detail: `${num} of ${den} next steps raised more than 30 days ago have been actioned.` });
    },
  },

  /* ══════════ BEHAVIOUR AND ATTITUDES ══════════ */
  {
    key: 'ba_attendance_rate', domain: 'behaviour_and_attitudes', weight: 3,
    label: 'Attendance rate (60 days)',
    why: 'Attendance is the first behaviour-and-attitudes number an inspector asks for.',
    link: '/attendance-monitoring.html',
    sources: ['attendance'],
    async run(ctx) {
      if (ctx.counts.attendance === 0) return noData('No attendance has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE coalesce(absent, false) = false)::int AS num
          FROM attendance WHERE date >= current_date - 60
           AND NOT EXISTS (SELECT 1 FROM children dc WHERE dc.id = attendance.child_id AND COALESCE(dc.is_demo, false))`);
      const { den, num } = rows[0];
      if (!den) return noData('No attendance recorded in the last 60 days.');
      return share(num, den, { detail: `${num} of ${den} register entries in the last 60 days were present.` });
    },
  },
  {
    key: 'ba_register_completeness', domain: 'behaviour_and_attitudes', weight: 2,
    label: 'Register taken on opening days',
    why: 'A missing register is a missing safeguarding record — you cannot say who was on site.',
    link: '/attendance-monitoring.html',
    sources: ['attendance'],
    async run(ctx) {
      if (ctx.counts.attendance === 0) return noData('No attendance has ever been recorded.');
      const { rows } = await ctx.db.query(`
        WITH days AS (
          SELECT d::date AS day
            FROM generate_series(current_date - 28, current_date - 1, interval '1 day') d
           WHERE extract(isodow FROM d) < 6)
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM attendance a WHERE a.date = days.day))::int AS num
          FROM days`);
      const { den, num } = rows[0];
      if (!den) return noData('No weekdays in the window.');
      return share(num, den, { detail: `${num} of the last ${den} weekdays have a register entry.` });
    },
  },
  {
    key: 'ba_key_person', domain: 'behaviour_and_attitudes', weight: 3,
    label: 'Children with a named key person',
    why: 'The EYFS requires every child to be assigned a key person. A blank is a statutory gap, not an admin one.',
    link: '/children.html',
    sources: ['children'],
    async run(ctx) {
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE key_person_id IS NOT NULL)::int AS num
          FROM children WHERE is_active = true AND COALESCE(is_demo, false) = false`);
      const { den, num } = rows[0];
      if (!den) return noData('No active children on roll.');
      return share(num, den, { detail: `${num} of ${den} active children have a key person assigned.` });
    },
  },
  {
    key: 'ba_settling', domain: 'behaviour_and_attitudes', weight: 1,
    label: 'Recent starters with a settling plan',
    why: 'Settling records show how new children are supported to belong.',
    link: '/children.html',
    sources: ['children', 'settling_in_plans'],
    async run(ctx) {
      if (ctx.counts.settling_in_plans === null) return noData('Settling plans are not available on this edition.');
      if (ctx.counts.settling_in_plans === 0) return noData('No settling plan has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM settling_in_plans s WHERE s.child_id = c.id))::int AS num
          FROM children c
         WHERE c.is_active = true AND c.start_date >= current_date - 120 AND COALESCE(c.is_demo, false) = false`);
      const { den, num } = rows[0];
      if (!den) return noData('No children have started in the last 120 days.');
      return share(num, den, { detail: `${num} of ${den} children who started in the last 120 days have a settling plan.` });
    },
  },

  /* ══════════ PERSONAL DEVELOPMENT ══════════ */
  {
    key: 'pd_sen_reviews', domain: 'personal_development', weight: 3,
    label: 'SEN APDR reviews on time',
    why: 'An overdue assess-plan-do-review cycle is support that has stopped being reviewed.',
    link: '/sen-register.html',
    sources: ['sen_apdr_cycles'],
    async run(ctx) {
      if (ctx.counts.sen_apdr_cycles === null) return noData('APDR cycles are not available on this edition.');
      if (ctx.counts.sen_apdr_cycles === 0) return noData('No APDR cycle has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE review_date >= current_date)::int AS num
          FROM sen_apdr_cycles
         WHERE review_date IS NOT NULL
           AND coalesce(status,'open') NOT IN ('closed','complete','completed')`);
      const { den, num } = rows[0];
      if (!den) return noData('No open APDR cycle currently carries a review date.');
      return share(num, den, { detail: `${num} of ${den} open APDR cycles have their review date still ahead.` });
    },
  },
  {
    key: 'pd_sen_register_current', domain: 'personal_development', weight: 2,
    label: 'SEN register entries in review date',
    why: 'A register entry past its review date has not been revisited since the need was first recorded.',
    link: '/sen-register.html',
    sources: ['sen_register'],
    async run(ctx) {
      if (ctx.counts.sen_register === null) return noData('The SEN register is not available on this edition.');
      if (ctx.counts.sen_register === 0) return noData('No child is on the SEN register.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE coalesce(review_date, annual_review_date) >= current_date)::int AS num
          FROM sen_register
         WHERE is_active = true AND coalesce(review_date, annual_review_date) IS NOT NULL`);
      const { den, num } = rows[0];
      if (!den) return noData('No active SEN register entry carries a review date.');
      return share(num, den, { detail: `${num} of ${den} active SEN register entries are still within their review date.` });
    },
  },
  {
    key: 'pd_cpd_completion', domain: 'personal_development', weight: 2,
    label: 'Staff with CPD in the last 12 months',
    why: 'Continuous professional development is what an inspector reads as a culture of improvement.',
    link: '/staff-knowledge.html',
    sources: ['staff', 'cpd_records'],
    async run(ctx) {
      if (ctx.counts.cpd_records === null) return noData('CPD records are not available on this edition.');
      if (ctx.counts.cpd_records === 0) return noData('No CPD record has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM cpd_records r
                                               WHERE r.staff_id = s.id
                                                 AND r.completion_date >= current_date - 365))::int AS num
          FROM staff s WHERE s.is_active = true AND COALESCE(s.is_demo, false) = false`);
      const { den, num } = rows[0];
      if (!den) return noData('No active staff.');
      return share(num, den, { detail: `${num} of ${den} active staff have completed CPD in the last 12 months.` });
    },
  },
  {
    key: 'pd_knowledge_quiz', domain: 'personal_development', weight: 2,
    label: 'Staff knowledge-check accuracy',
    why: 'Quiz accuracy shows whether safeguarding and practice knowledge is actually held, not just attended.',
    link: '/staff-knowledge.html',
    sources: ['reflection_quiz_attempts'],
    async run(ctx) {
      if (ctx.counts.reflection_quiz_attempts === null) return noData('Knowledge checks are not available on this edition.');
      if (ctx.counts.reflection_quiz_attempts === 0) return noData('No staff member has attempted a knowledge check yet.');
      const { rows } = await ctx.db.query(`
        SELECT coalesce(sum(score), 0)::int AS num, coalesce(sum(total), 0)::int AS den, count(*)::int AS attempts
          FROM reflection_quiz_attempts
         WHERE taken_at >= current_date - 365 AND total > 0`);
      const { den, num, attempts } = rows[0];
      if (!den) return noData('No knowledge check has been attempted in the last 12 months.');
      return share(num, den, { detail: `${num} of ${den} questions answered correctly across ${attempts} attempt(s) in the last 12 months.` });
    },
  },
  {
    key: 'pd_knowledge_checks', domain: 'personal_development', weight: 1,
    label: 'Assigned knowledge checks completed',
    why: 'An assigned check left pending is a training gap that has been identified but not closed.',
    link: '/staff-knowledge.html',
    sources: ['knowledge_check_assignments'],
    async run(ctx) {
      if (ctx.counts.knowledge_check_assignments === null) return noData('Knowledge-check assignments are not available on this edition.');
      if (ctx.counts.knowledge_check_assignments === 0) return noData('No knowledge check has ever been assigned.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE completed_at IS NOT NULL
                                   OR lower(coalesce(status,'')) IN ('complete','completed','passed'))::int AS num
          FROM knowledge_check_assignments`);
      const { den, num } = rows[0];
      if (!den) return noData('No knowledge check has ever been assigned.');
      return share(num, den, { detail: `${num} of ${den} assigned knowledge checks have been completed.` });
    },
  },

  /* ══════════ LEADERSHIP AND MANAGEMENT ══════════ */
  {
    key: 'lm_safeguarding_training', domain: 'leadership_and_management', weight: 3,
    label: 'Staff with current safeguarding training',
    why: 'Out-of-date safeguarding training is the single fastest route to an inadequate leadership judgement.',
    link: '/single-central-record.html',
    sources: ['staff', 'safeguarding_training'],
    async run(ctx) {
      if (ctx.counts.safeguarding_training === null) return noData('Safeguarding training records are not available on this edition.');
      if (ctx.counts.safeguarding_training === 0) return noData('No safeguarding training has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM safeguarding_training t
                  WHERE t.staff_id = s.id
                    AND (t.expiry_date >= current_date
                         OR (t.expiry_date IS NULL AND t.completed_date >= current_date - 1095))))::int AS num
          FROM staff s WHERE s.is_active = true AND COALESCE(s.is_demo, false) = false`);
      const { den, num } = rows[0];
      if (!den) return noData('No active staff.');
      return share(num, den, { detail: `${num} of ${den} active staff hold in-date safeguarding training (an undated record counts for 3 years).` });
    },
  },
  {
    key: 'lm_dbs_current', domain: 'leadership_and_management', weight: 3,
    label: 'Staff with a recorded, in-date DBS',
    why: 'The Single Central Record is checked at every inspection; a blank or expired DBS is an immediate finding.',
    link: '/single-central-record.html',
    sources: ['staff'],
    async run(ctx) {
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE dbs_number IS NOT NULL AND btrim(dbs_number) <> ''
                                  AND (dbs_expiry IS NULL OR dbs_expiry >= current_date))::int AS num
          FROM staff WHERE is_active = true AND COALESCE(is_demo, false) = false`);
      const { den, num } = rows[0];
      if (!den) return noData('No active staff.');
      return share(num, den, { detail: `${num} of ${den} active staff have a DBS number on file that has not expired.` });
    },
  },
  {
    key: 'lm_rtw_current', domain: 'leadership_and_management', weight: 2,
    label: 'Staff with a recorded, in-date right to work',
    why: 'Right-to-work evidence is a statutory SCR column with no acceptable blank.',
    link: '/single-central-record.html',
    sources: ['staff'],
    async run(ctx) {
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE right_to_work_check_date IS NOT NULL
                                  AND (right_to_work_expiry_date IS NULL OR right_to_work_expiry_date >= current_date))::int AS num
          FROM staff WHERE is_active = true AND COALESCE(is_demo, false) = false`);
      const { den, num } = rows[0];
      if (!den) return noData('No active staff.');
      return share(num, den, { detail: `${num} of ${den} active staff have a right-to-work check on file that has not expired.` });
    },
  },
  {
    key: 'lm_paediatric_first_aid', domain: 'leadership_and_management', weight: 2,
    label: 'Paediatric first aiders on the team',
    why: 'The EYFS requires enough paediatric first aiders on site whenever children are present.',
    link: '/single-central-record.html',
    sources: ['staff', 'mandatory_training', 'settings.report_card_pfa_target'],
    async run(ctx) {
      if (ctx.counts.mandatory_training === null) return noData('Training records are not available on this edition.');
      if (ctx.counts.mandatory_training === 0) return noData('No training record has ever been recorded.');
      const target = await getNumSetting(ctx.db, 'report_card_pfa_target', 3);
      if (!target) return noData('Paediatric first aid target (settings.report_card_pfa_target) is set to zero.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS n
          FROM staff s
         WHERE s.is_active = true
           AND COALESCE(s.is_demo, false) = false
           AND EXISTS (SELECT 1 FROM mandatory_training t
                        WHERE t.staff_id = s.id
                          AND (t.training_type ILIKE '%paediatric%' OR t.training_type ILIKE '%first aid%'
                               OR t.training_type ILIKE '%first_aid%')
                          AND (t.expiry_date >= current_date
                               OR (t.expiry_date IS NULL AND t.completed_date >= current_date - 1095)))`);
      return againstTarget(rows[0].n, target, {
        unit: ' first aiders',
        detail: `${rows[0].n} active staff hold in-date paediatric first aid against a local target of ${target} ` +
                `(settings.report_card_pfa_target — a setting-level target, not a statutory figure).`,
      });
    },
  },
  {
    key: 'lm_supervisions', domain: 'leadership_and_management', weight: 3,
    label: 'Staff supervised within the cycle',
    why: 'Supervision is a statutory EYFS requirement and the evidence that staff are supported and held to account.',
    link: '/supervisions.html',
    sources: ['staff', 'supervisions', 'settings.supervision_cycle_months'],
    async run(ctx) {
      if (ctx.counts.supervisions === null) return noData('Supervisions are not available on this edition.');
      if (ctx.counts.supervisions === 0) return noData('No supervision has ever been recorded.');
      const months = await getNumSetting(ctx.db, 'supervision_cycle_months', 6);
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM supervisions sv
                  WHERE sv.staff_id = s.id
                    AND coalesce(sv.conducted_date, sv.scheduled_date) >= current_date - ($1::int * 30)
                    AND lower(coalesce(sv.status,'')) IN ('completed','complete','signed_off','finalised','finalized')))::int AS num
          FROM staff s WHERE s.is_active = true AND COALESCE(s.is_demo, false) = false`, [months]);
      const { den, num } = rows[0];
      if (!den) return noData('No active staff.');
      return share(num, den, { detail: `${num} of ${den} active staff have a completed supervision within the last ${months} months.` });
    },
  },
  {
    key: 'lm_policy_reviews', domain: 'leadership_and_management', weight: 2,
    label: 'Policies within their review date',
    why: 'A policy past its review date is a policy nobody can say still reflects practice.',
    link: '/policies-workspace.html',
    sources: ['policies'],
    async run(ctx) {
      if (ctx.counts.policies === 0) return noData('No policy has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE review_due >= current_date)::int AS num
          FROM policies WHERE is_active = true AND review_due IS NOT NULL`);
      const { den, num } = rows[0];
      if (!den) return noData('No active policy carries a review date yet (b186 adds policies.review_due).');
      return share(num, den, { detail: `${num} of ${den} active policies with a review date are still in date.` });
    },
  },
  {
    key: 'lm_risk_assessments', domain: 'leadership_and_management', weight: 2,
    label: 'Risk assessments within their review date',
    why: 'Current risk assessments are the written evidence that hazards are actively managed.',
    link: '/admin/operations/health-safety',
    sources: ['risk_assessments'],
    async run(ctx) {
      if (ctx.counts.risk_assessments === null) return noData('Risk assessments are not available on this edition.');
      if (ctx.counts.risk_assessments === 0) return noData('No risk assessment has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE review_date >= current_date)::int AS num
          FROM risk_assessments
         WHERE coalesce(status,'active') NOT IN ('archived','superseded') AND review_date IS NOT NULL`);
      const { den, num } = rows[0];
      if (!den) return noData('No live risk assessment carries a review date.');
      return share(num, den, { detail: `${num} of ${den} live risk assessments are still within their review date.` });
    },
  },
  {
    key: 'lm_ratio_compliance', domain: 'leadership_and_management', weight: 3,
    label: 'Headcounts meeting ratio',
    why: 'Ratio breaches recorded at headcount are the hardest evidence there is of how the setting actually runs.',
    link: '/room-headcounts.html',
    sources: ['room_headcounts'],
    async run(ctx) {
      if (ctx.counts.room_headcounts === null) return noData('Room headcounts are not available on this edition.');
      if (ctx.counts.room_headcounts === 0) return noData('No headcount has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE ratio_ok)::int AS num
          FROM room_headcounts
         WHERE status = 'completed' AND scheduled_for >= current_date - 90 AND ratio_ok IS NOT NULL`);
      const { den, num } = rows[0];
      if (!den) return noData('No headcount has been completed with a ratio result in the last 90 days.');
      return share(num, den, { detail: `${num} of ${den} completed headcounts in the last 90 days were within ratio.` });
    },
  },
  {
    key: 'lm_headcount_completion', domain: 'leadership_and_management', weight: 1,
    label: 'Scheduled headcounts actually done',
    why: 'A missed headcount produces no ratio evidence at all — the check is only worth what gets completed.',
    link: '/room-headcounts.html',
    sources: ['room_headcounts'],
    async run(ctx) {
      if (ctx.counts.room_headcounts === null) return noData('Room headcounts are not available on this edition.');
      if (ctx.counts.room_headcounts === 0) return noData('No headcount has ever been scheduled.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE status = 'completed')::int AS num
          FROM room_headcounts
         WHERE scheduled_for >= current_date - 90 AND scheduled_for < now()`);
      const { den, num } = rows[0];
      if (!den) return noData('No headcount was scheduled in the last 90 days.');
      return share(num, den, { detail: `${num} of ${den} headcounts due in the last 90 days were completed.` });
    },
  },
  {
    // b189 — off-ratio accountability. Deliberately weight 1: this is a RECORD-KEEPING
    // metric, not a safety one. Being over ratio is usually deliberate and good; what
    // this scores is whether the setting can say what the extra time was used for.
    // Scoring it any higher would turn a reflective prompt into a target.
    key: 'lm_offratio_accounted', domain: 'leadership_and_management', weight: 1,
    label: 'Off-ratio time accounted for',
    why: 'Off-ratio time is normally well spent — settling, SEND support, planning, supervision. '
       + 'Recording which turns invisible time into something the setting can evidence and talk about.',
    link: '/rota.html',
    sources: ['offratio_log'],
    async run(ctx) {
      if (ctx.counts.offratio_log === null) return noData('Off-ratio logging is not available on this edition.');
      if (ctx.counts.offratio_log === 0) return noData('No off-ratio day has been recorded yet.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE account IS NOT NULL AND btrim(account) <> '')::int AS num
          FROM offratio_log
         WHERE date >= current_date - 90 AND date <= current_date`);
      const { den, num } = rows[0];
      if (!den) return noData('No off-ratio day was flagged in the last 90 days.');   // future-dated rows are excluded above — you cannot account for a day that has not happened
      return share(num, den, { detail: `${num} of ${den} off-ratio days in the last 90 days have a written account.` });
    },
  },
  {
    key: 'lm_incident_followup', domain: 'leadership_and_management', weight: 1,
    label: 'Incidents reviewed by a manager',
    why: 'An unreviewed accident record is a pattern nobody has looked at.',
    link: '/incidents.html',
    sources: ['incidents'],
    async run(ctx) {
      if (ctx.counts.incidents === 0) return noData('No incident has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE coalesce(manager_reviewed, false) OR manager_sign_off_at IS NOT NULL)::int AS num
          FROM incidents WHERE incident_date >= current_date - 180`);
      const { den, num } = rows[0];
      if (!den) return noData('No incident recorded in the last 180 days.');
      return share(num, den, { detail: `${num} of ${den} incidents in the last 180 days have been reviewed by a manager.` });
    },
  },
  {
    // b193 — Ofsted notification. Weight 3: this is the one on this page with a
    // statutory deadline attached to it. EYFS requires providers to notify Ofsted
    // of significant events affecting their suitability to care for children (and
    // of food poisoning affecting two or more children) within 14 days. An event
    // the setting recorded and then never notified is worse than one it never
    // spotted, because the record proves it knew.
    key: 'lm_ofsted_notifications', domain: 'leadership_and_management', weight: 3,
    label: 'Ofsted notifications made on time',
    why: 'A notifiable event Wren is holding but Ofsted has not been told about is the clearest '
       + 'possible leadership failing — the setting recorded it, so it knew.',
    link: '/setting-incidents.html',
    sources: ['setting_incidents'],
    async run(ctx) {
      if (ctx.counts.setting_incidents === null) return noData('Setting incidents are not available on this edition.');
      if (ctx.counts.setting_incidents === 0) return noData('No setting incident has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (
                 WHERE ofsted_notified_at IS NOT NULL
                   AND (ofsted_due_by IS NULL OR ofsted_notified_at::date <= ofsted_due_by)
               )::int AS num,
               count(*) FILTER (WHERE ofsted_notified_at IS NULL AND ofsted_due_by < current_date)::int AS overdue
          FROM setting_incidents
         WHERE ofsted_notifiable = true AND occurred_at >= current_date - 365`);
      const { den, num, overdue } = rows[0];
      if (!den) return noData('No Ofsted-notifiable event in the last 12 months.');
      return share(num, den, {
        detail: `${num} of ${den} notifiable event(s) in the last 12 months were notified within the deadline`
              + (Number(overdue) ? `; ${overdue} still not notified and past the 14 days.` : '.'),
      });
    },
  },
  {
    // Weight 1: the reflective half. A setting incident closed with no actions
    // and no lessons is a filed piece of paper, not a change in practice — but
    // an OPEN incident is not a failing, so only closed ones are scored.
    key: 'lm_setting_incident_learning', domain: 'leadership_and_management', weight: 1,
    label: 'Setting incidents closed with lessons recorded',
    why: 'Closing a fire, an intruder or a lost-child record without writing what changed '
       + 'means the next one happens the same way.',
    link: '/setting-incidents.html',
    sources: ['setting_incidents'],
    async run(ctx) {
      if (ctx.counts.setting_incidents === null) return noData('Setting incidents are not available on this edition.');
      if (ctx.counts.setting_incidents === 0) return noData('No setting incident has ever been recorded.');
      const { rows } = await ctx.db.query(`
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE lessons_learned IS NOT NULL AND btrim(lessons_learned) <> '')::int AS num
          FROM setting_incidents
         WHERE status = 'closed' AND occurred_at >= current_date - 365`);
      const { den, num } = rows[0];
      if (!den) return noData('No setting incident has been closed in the last 12 months.');
      return share(num, den, { detail: `${num} of ${den} closed setting incidents record what changed as a result.` });
    },
  },
];

/* ── engine ────────────────────────────────────────────────────────────────── */

/** Tables whose lifetime row count decides "never used" vs "genuinely zero". */
const COUNTED_TABLES = [
  'children', 'observations', 'framework_tracker', 'weekly_plans', 'next_steps',
  'attendance', 'settling_in_plans', 'sen_apdr_cycles', 'sen_register', 'cpd_records',
  'reflection_quiz_attempts', 'knowledge_check_assignments', 'safeguarding_training',
  'mandatory_training', 'supervisions', 'policies', 'risk_assessments',
  'room_headcounts', 'incidents',
  'offratio_log',   // b189 — null here (table absent) means "not available on this edition"
  'setting_incidents', // b193 — fire/intruder/lost child/outbreak: the third record
];

function ragFor(score, green, amber) {
  if (score == null) return 'no_data';
  if (score >= green) return 'green';
  if (score >= amber) return 'amber';
  return 'red';
}

/**
 * Compute the whole report card.
 * @returns {object} { computed_at, disclaimer, overall, domains[], weakest[], excluded[] }
 */
async function buildReportCard(db) {
  const green = await getNumSetting(db, 'report_card_green', DEFAULT_GREEN);
  const amber = await getNumSetting(db, 'report_card_amber', DEFAULT_AMBER);

  // Lifetime row counts — one pass, so each metric can tell "never used" from "zero".
  const counts = {};
  for (const t of COUNTED_TABLES) counts[t] = await tableRowCount(db, t);

  // Memoised 90-day observation-group roll-up, shared by three sub-metrics.
  let _obsGroups = null;
  const ctx = {
    db, counts,
    async obsGroups() {
      if (_obsGroups) return _obsGroups;
      const { rows } = await db.query(`
        WITH g AS (
          SELECT ${OBS_EFFORT_KEY} AS k,
                 bool_or(o.next_steps IS NOT NULL AND btrim(o.next_steps) <> '') AS has_ns,
                 bool_or(coalesce(array_length(o.linked_framework_ids, 1), 0) > 0) AS has_fw
            FROM observations o
           WHERE o.created_at >= current_date - 90
           GROUP BY 1)
        SELECT count(*)::int AS den,
               count(*) FILTER (WHERE has_ns)::int AS ns,
               count(*) FILTER (WHERE has_fw)::int AS fw
          FROM g`);
      _obsGroups = rows[0];
      return _obsGroups;
    },
  };

  const results = [];
  for (const m of METRICS) {
    let r;
    try {
      r = await m.run(ctx);
    } catch (e) {
      // A source this edition does not carry, or a column that has moved. Cost
      // is this one sub-metric — never the whole card, and never a fake zero.
      console.warn(`[report-card] ${m.key} skipped: ${e.message}`);
      r = noData(`Could not be measured: ${e.message}`);
    }
    results.push({
      key: m.key, domain: m.domain, label: m.label, weight: m.weight,
      why: m.why, link: m.link, sources: m.sources,
      score: r.score == null ? null : Math.round(r.score),
      value: r.value != null ? r.value : null,
      unit: r.unit || '',
      numerator: r.numerator != null ? r.numerator : null,
      denominator: r.denominator != null ? r.denominator : null,
      detail: r.detail || null,
      no_data: r.no_data || null,
      status: ragFor(r.score == null ? null : Math.round(r.score), green, amber),
    });
  }

  // ── domain roll-up: weighted mean of SCORED sub-metrics only ───────────────
  // A domain resting on only a small share of its intended weight is still
  // reported — but flagged low_confidence, because "0 out of the one thing we
  // could measure" must not read like "0 across the board".
  const domains = DOMAINS.map(d => {
    const subs   = results.filter(r => r.domain === d.key);
    const scored = subs.filter(r => r.score != null);
    const wSum   = scored.reduce((a, r) => a + r.weight, 0);
    const wAll   = subs.reduce((a, r) => a + r.weight, 0);
    const score  = wSum ? Math.round(scored.reduce((a, r) => a + r.score * r.weight, 0) / wSum) : null;
    const coverage = wAll ? Math.round((wSum / wAll) * 100) : 0;
    return {
      key: d.key, label: d.label, icon: d.icon, blurb: d.blurb,
      score,
      status: ragFor(score, green, amber),
      sub_metrics: subs,
      scored_count: scored.length,
      no_data_count: subs.length - scored.length,
      weight_scored: wSum,
      weight_total: wAll,
      coverage,
      low_confidence: score != null && coverage < LOW_CONFIDENCE_COVERAGE,
      basis: wSum
        ? `Weighted mean of ${scored.length} of ${subs.length} sub-metrics ` +
          `(${coverage}% of this domain's intended weight); ` +
          `${subs.length - scored.length} excluded for having no data.`
        : 'No sub-metric in this domain has data — the domain is not scored.',
    };
  });

  const scoredDomains = domains.filter(d => d.score != null);
  const overallScore = scoredDomains.length
    ? Math.round(scoredDomains.reduce((a, d) => a + d.score * d.weight_scored, 0) /
                 scoredDomains.reduce((a, d) => a + d.weight_scored, 0))
    : null;

  // ── "fix these first": impact = weight × the points still missing ──────────
  const weakest = results
    .filter(r => r.score != null && r.score < green)
    .map(r => ({
      key: r.key, domain: r.domain,
      domain_label: (DOMAINS.find(d => d.key === r.domain) || {}).label || r.domain,
      label: r.label, score: r.score, status: r.status, detail: r.detail,
      why: r.why, link: r.link,
      numerator: r.numerator, denominator: r.denominator,
      // Points of the domain average this sub-metric is currently giving away.
      impact: round1(r.weight * (100 - r.score) / 100),
      gap: r.denominator != null && r.numerator != null ? r.denominator - r.numerator : null,
    }))
    .sort((a, b) => b.impact - a.impact || a.score - b.score)
    .slice(0, 5);

  const excluded = results.filter(r => r.score == null)
    .map(r => ({ key: r.key, domain: r.domain, label: r.label, reason: r.no_data }));

  return {
    computed_at: new Date().toISOString(),
    disclaimer: DISCLAIMER,
    thresholds: { green, amber },
    overall: {
      score: overallScore,
      status: ragFor(overallScore, green, amber),
      scored_domains: scoredDomains.length,
      total_domains: DOMAINS.length,
      scored_sub_metrics: results.filter(r => r.score != null).length,
      total_sub_metrics: results.length,
      excluded_sub_metrics: excluded.length,
    },
    domains,
    weakest,
    excluded,
  };
}

/** One-line summary for the monthly digest / notifications. */
function summaryLine(card) {
  if (!card || !card.overall || card.overall.score == null) {
    return 'Setting report card: not enough recorded data to produce a readiness indicator yet.';
  }
  const top = card.weakest[0];
  return `Setting report card: ${card.overall.score}/100 readiness indicator (${card.overall.status.toUpperCase()}) — ` +
         card.domains.map(d => `${d.label} ${d.score == null ? 'n/a' : d.score}${d.low_confidence ? '*' : ''}`).join(', ') +
         (top ? `. Fix first: ${top.label} (${top.score}%).` : '.') +
         (card.domains.some(d => d.low_confidence)
            ? ' (* scored from under half that domain\'s inputs — the rest have no data.)' : '') +
         ' Internal indicator only — not an Ofsted grade.';
}

/** CREATE TABLE IF NOT EXISTS for the snapshot store (idempotent, additive). */
const SNAPSHOT_DDL = `
CREATE TABLE IF NOT EXISTS report_card_snapshots (
  id             serial PRIMARY KEY,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  snapshot_date  date        NOT NULL DEFAULT current_date,
  overall_score  integer,
  rag            text,
  scores         jsonb       NOT NULL,
  weakest        jsonb       NOT NULL,
  source         text        NOT NULL DEFAULT 'api'
);
CREATE UNIQUE INDEX IF NOT EXISTS report_card_snapshots_date_uq
  ON report_card_snapshots (snapshot_date);`;

async function ensureSnapshotTable(db) {
  await db.query(SNAPSHOT_DDL);
}

/**
 * Store (or refresh) today's snapshot. One row per day — repeatedly opening the
 * page must not turn the trend line into noise.
 */
async function saveSnapshot(db, card, source) {
  await ensureSnapshotTable(db);
  const scores = {
    overall: card.overall,
    thresholds: card.thresholds,
    domains: card.domains.map(d => ({
      key: d.key, label: d.label, score: d.score, status: d.status, basis: d.basis,
      scored_count: d.scored_count, no_data_count: d.no_data_count,
      coverage: d.coverage, low_confidence: d.low_confidence,
      sub_metrics: d.sub_metrics.map(s => ({
        key: s.key, label: s.label, score: s.score, value: s.value, unit: s.unit,
        numerator: s.numerator, denominator: s.denominator,
        detail: s.detail, no_data: s.no_data, status: s.status, weight: s.weight, link: s.link,
      })),
    })),
    excluded: card.excluded,
  };
  const { rows } = await db.query(`
    INSERT INTO report_card_snapshots (computed_at, snapshot_date, overall_score, rag, scores, weakest, source)
    VALUES ($1, current_date, $2, $3, $4::jsonb, $5::jsonb, $6)
    ON CONFLICT (snapshot_date) DO UPDATE
       SET computed_at = EXCLUDED.computed_at,
           overall_score = EXCLUDED.overall_score,
           rag = EXCLUDED.rag,
           scores = EXCLUDED.scores,
           weakest = EXCLUDED.weakest,
           source = EXCLUDED.source
    RETURNING id, computed_at, snapshot_date`,
    [card.computed_at, card.overall.score, card.overall.status,
     JSON.stringify(scores), JSON.stringify(card.weakest), source || 'api']);
  return rows[0];
}

module.exports = {
  buildReportCard,
  saveSnapshot,
  ensureSnapshotTable,
  summaryLine,
  DOMAINS,
  DOMAIN_KEYS,
  METRICS,
  DISCLAIMER,
  SNAPSHOT_DDL,
};
