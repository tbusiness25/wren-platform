'use strict';
// login-20261023 — induction items that tick themselves (the Apprentice pathway).
//
// An item's auto_rule is '<kind>:<n>' (or 'ready'). Counted from the assignment's start date, from
// tables Wren already keeps — nothing here asks the starter to report anything twice:
//   obs_read:N       different observations they have opened          observation_reads
//   quiz_answers:N   answers to the tablet pop-up quiz                 knowledge_answers
//   quiz_correct:N   … of which right                                  knowledge_answers.correct
//   articles_read:N  CPD reading-list articles read                     cpd_article_reads
//   reflections:N    reflection notes written (private ones count)      staff_reflections (not practice obs)
//   practice_obs:N   practice observations written for their mentor     staff_reflections kind 'practice_observation'
//   ready            a manager has switched observations on for them   staff_capabilities observations.create
// Counts only — the contents of private reflections are never read here.

const RULE_RE = /^([a-z_]+)(?::(\d+))?$/;
const LABEL = {
  obs_read: 'observations read', quiz_answers: 'quiz answers', quiz_correct: 'right answers',
  articles_read: 'articles read', reflections: 'reflection notes', practice_obs: 'practice observations',
};

function parseRule(rule) {
  const m = RULE_RE.exec(String(rule || '').trim());
  return m ? { kind: m[1], need: m[2] ? Number(m[2]) : 1 } : null;
}

async function safeCount(db, sql, params) {
  try { const { rows } = await db.query(sql, params); return Number(rows[0] && rows[0].n) || 0; }
  catch (e) { if (e.code === '42P01' || e.code === '42703') return 0; throw e; }
}

/** How far a starter has got on one rule. { have, need, label } */
async function measure(db, staffId, since, rule) {
  const r = parseRule(rule);
  if (!r) return null;
  const p = [staffId, since || '1970-01-01'];
  let have = 0;
  switch (r.kind) {
    case 'obs_read':
      have = await safeCount(db, 'SELECT count(*) AS n FROM observation_reads WHERE staff_id=$1 AND first_read_at >= $2::date', p); break;
    case 'quiz_answers':
      have = await safeCount(db, 'SELECT count(*) AS n FROM knowledge_answers WHERE staff_id=$1 AND answered_at >= $2::date', p); break;
    case 'quiz_correct':
      have = await safeCount(db, 'SELECT count(*) AS n FROM knowledge_answers WHERE staff_id=$1 AND correct AND answered_at >= $2::date', p); break;
    case 'articles_read':
      have = await safeCount(db, 'SELECT count(DISTINCT article_id) AS n FROM cpd_article_reads WHERE staff_id=$1 AND read_at >= $2::date', p); break;
    case 'reflections':
      have = await safeCount(db, "SELECT count(*) AS n FROM staff_reflections WHERE staff_id=$1 AND created_at >= $2::date AND kind IS DISTINCT FROM 'practice_observation'", p); break;
    case 'practice_obs':
      have = await safeCount(db, "SELECT count(*) AS n FROM staff_reflections WHERE staff_id=$1 AND created_at >= $2::date AND kind = 'practice_observation'", p); break;
    case 'ready':
      have = (await isReadyToObserve(db, staffId)) ? 1 : 0; break;
    default: return null;
  }
  return { have, need: r.need, label: LABEL[r.kind] || null, kind: r.kind };
}

/** Observations are switched on for this person: by role (not an apprentice) or by a manager's grant. */
async function isReadyToObserve(db, staffId) {
  const { rows } = await db.query(
    `SELECT s.role,
            EXISTS (SELECT 1 FROM staff_capabilities sc JOIN capabilities c ON c.id = sc.capability_id
                     WHERE sc.staff_id = s.id AND c.key = 'observations.create' AND sc.level IN ('edit','approve','manage')) AS granted
       FROM staff s WHERE s.id = $1`, [staffId]);
  if (!rows.length) return false;
  return rows[0].granted || rows[0].role !== 'apprentice';
}

/**
 * Tick every auto-rule item on an assignment whose count has been reached. Sign-off-only items are
 * left for a person to sign, except 'ready', which IS the manager's switch. Returns
 * { [item_id]: { have, need, label } } for the screen.
 */
async function applyAutoRules(db, assignment) {
  let items;
  try {
    ({ rows: items } = await db.query(
      `SELECT ti.id, ti.auto_rule, ip.status FROM induction_template_items ti
         LEFT JOIN induction_item_progress ip ON ip.item_id = ti.id AND ip.assignment_id = $1
        WHERE ti.template_id = $2 AND ti.auto_rule IS NOT NULL AND ti.auto_rule <> ''`,
      [assignment.id, assignment.template_id]));
  } catch (e) { if (e.code === '42703') return {}; throw e; }   // tenant without the migration
  const out = {};
  for (const it of items) {
    const m = await measure(db, assignment.staff_id, assignment.start_date || assignment.created_at, it.auto_rule);
    if (!m) continue;
    out[it.id] = { have: Math.min(m.have, m.need), need: m.need, label: m.label };
    if (m.have >= m.need && !['done', 'signed_off'].includes(it.status)) {
      await db.query(
        `INSERT INTO induction_item_progress (assignment_id, item_id, status, completed_at, evidence_note)
         VALUES ($1, $2, 'done', now(), $3)
         ON CONFLICT (assignment_id, item_id) DO UPDATE
           SET status = 'done', completed_at = COALESCE(induction_item_progress.completed_at, now()),
               evidence_note = COALESCE(induction_item_progress.evidence_note, EXCLUDED.evidence_note)
         WHERE induction_item_progress.status IN ('pending', 'in_progress')`,
        [assignment.id, it.id, m.kind === 'ready' ? 'Observations switched on by a manager' : `Auto-completed: ${m.need} ${m.label}`]);
    }
  }
  return out;
}

module.exports = { parseRule, measure, applyAutoRules, isReadyToObserve };
