'use strict';
// b334 — computes the duty_status cache. The matrix API reads duty_status only;
// it never recomputes 40+ children x 24 duties on a page load. Call refreshAll()
// on a timer (src/routes/duties.js) or on demand (POST /api/duties/refresh).

const evaluators = require('./evaluators');

const SCOPE_SUBJECTS = {
  child:   `SELECT id FROM children WHERE is_active = true`,
  room:    `SELECT id FROM rooms`,
  staff:   `SELECT id FROM staff WHERE is_active = true`,
  setting: null, // single virtual subject, id 0
};

async function subjectIds(db, scope) {
  if (scope === 'setting') return [0];
  const { rows } = await db.query(SCOPE_SUBJECTS[scope]);
  return rows.map(r => r.id);
}

/** Refresh every active duty x every applicable subject. Returns a count summary. */
async function refreshAll(db) {
  const { rows: defs } = await db.query(`SELECT * FROM duty_definitions WHERE is_active = true ORDER BY sort_order`);
  const today = new Date();
  let computed = 0, failed = 0;
  for (const def of defs) {
    const evaluator = evaluators[def.source_key];
    if (typeof evaluator !== 'function') {
      console.error(`[duties] no evaluator for source_key "${def.source_key}" (duty ${def.key})`);
      continue;
    }
    const ids = await subjectIds(db, def.scope);
    for (const subjectId of ids) {
      try {
        const r = await evaluator(db, subjectId, def, today);
        await db.query(
          `INSERT INTO duty_status (duty_key, subject_type, subject_id, state, last_done_date, last_done_by, next_due_date, detail, computed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
           ON CONFLICT (duty_key, subject_type, subject_id) DO UPDATE SET
             state = EXCLUDED.state, last_done_date = EXCLUDED.last_done_date, last_done_by = EXCLUDED.last_done_by,
             next_due_date = EXCLUDED.next_due_date, detail = EXCLUDED.detail, computed_at = EXCLUDED.computed_at`,
          [def.key, def.scope, subjectId, r.state,
           r.last_done_date || null, r.last_done_by || null, r.next_due_date || null,
           r.detail ? JSON.stringify(r.detail) : null]);
        computed++;
      } catch (e) {
        failed++;
        console.error(`[duties] evaluator "${def.source_key}" failed for ${def.scope} #${subjectId}:`, e.message);
      }
    }
  }
  return { computed, failed, duties: defs.length, at: today.toISOString() };
}

module.exports = { refreshAll, subjectIds };
