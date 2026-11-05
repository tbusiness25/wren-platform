'use strict';
// b335 (2026-09-15) — the concern pathway. Reads/writes pathway_templates,
// pathway_stages, child_pathways, child_pathway_stages (scripts/b335-pathways.sql).
//
// Deliberately live-computed, not a cached cache like b334's duty_status: a
// setting this size has a handful of open pathways at once, not 85 children
// x 24 duties, so there's no performance reason to precompute.

const GRACE_DAYS = 10; // "due_soon" window before a stage's due_date, matches b334's typical grace

// pg returns a `date` column as a local-midnight JS Date, not a string — string-
// concatenating it (`row.due_date + 'T00:00:00Z'`) silently coerces via
// Date#toString() into garbage. Normalise with local getters (not toISOString,
// which can shift the calendar day under a non-UTC TZ) before doing any date math.
function toYmd(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function effectiveStatus(row, today) {
  // row.status is the PERSISTED fact (pending/done/not_applicable). This
  // layers 'overdue'/'due_soon' on top for display, computed off due_date —
  // never stored, so there is one source of truth for "is this done".
  if (row.status === 'done' || row.status === 'not_applicable') return row.status;
  const ymd = toYmd(row.due_date);
  if (!ymd) return 'pending';
  const due = new Date(ymd + 'T00:00:00Z');
  const t = today || new Date();
  const diffDays = Math.floor((due - Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= GRACE_DAYS) return 'due_soon';
  return 'pending';
}

/** Every stage of a template, in order. */
async function templateStages(db, templateId) {
  const { rows } = await db.query(
    `SELECT * FROM pathway_stages WHERE template_id=$1 ORDER BY stage_order`, [templateId]);
  return rows;
}

/**
 * Start a pathway for a child: creates child_pathways + one child_pathway_stages
 * row per template stage. Stage 1 (due_offset_days=0) is marked DONE immediately,
 * evidenced by whatever triggered the start (the safeguarding concern, the SEN
 * register entry, or the manual note) — starting a pathway IS "a concern was
 * raised". Every later stage's due_date is set from stage 1's due_offset chain;
 * a stage with due_offset_days=null (transition/leaving — event-driven, not
 * calendar-driven) gets no due_date until it is reached.
 */
async function startPathway(db, { childId, templateKey, startedBy, startedReason, sourceTable, sourceId }) {
  const { rows: tmplRows } = await db.query(
    `SELECT * FROM pathway_templates WHERE key=$1 AND is_active=true`, [templateKey]);
  const template = tmplRows[0];
  if (!template) throw new Error(`Unknown pathway template "${templateKey}"`);
  if (!childId) throw new Error('childId required');

  // A child already has one running: don't stack a second — the whole point
  // of a pathway is ONE timeline for the situation, not one per thing that
  // triggered it. Surfaced as a clear, catchable error rather than silently
  // no-op'd, so the two automatic hooks (safeguarding, SEN) — which run
  // wrapped in try/catch and can't see each other — fail safely instead of
  // duplicating, and the Roost "start a pathway" button can tell the manager
  // exactly which existing pathway to use instead.
  const { rows: existing } = await db.query(
    `SELECT id FROM child_pathways WHERE child_id=$1 AND template_id=$2 AND status='open'`,
    [childId, template.id]);
  if (existing.length) {
    throw new Error(`This child already has an open "${template.label}" pathway (id ${existing[0].id})`);
  }

  const stages = await templateStages(db, template.id);
  if (!stages.length) throw new Error(`Template "${templateKey}" has no stages`);

  const { rows: pwRows } = await db.query(
    `INSERT INTO child_pathways (child_id, template_id, started_by, started_reason, source_table, source_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [childId, template.id, startedBy || null, startedReason || null, sourceTable || null, sourceId || null]);
  const pathway = pwRows[0];

  const today = new Date().toISOString().slice(0, 10);
  let runningDue = today;
  for (const stage of stages) {
    const isFirst = stage.stage_order === stages[0].stage_order;
    let dueDate = null;
    if (isFirst) {
      dueDate = today;
    } else if (stage.due_offset_days != null) {
      const d = new Date(runningDue + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + stage.due_offset_days);
      dueDate = d.toISOString().slice(0, 10);
    }
    if (dueDate) runningDue = dueDate;

    if (isFirst) {
      await db.query(
        `INSERT INTO child_pathway_stages
           (child_pathway_id, stage_id, status, due_date, done_at, done_by, evidence_table, evidence_id, notes)
         VALUES ($1,$2,'done',$3,now(),$4,$5,$6,$7)`,
        [pathway.id, stage.id, dueDate, startedBy || null, sourceTable || null, sourceId || null,
         startedReason || null]);
    } else {
      await db.query(
        `INSERT INTO child_pathway_stages (child_pathway_id, stage_id, status, due_date)
         VALUES ($1,$2,'pending',$3)`,
        [pathway.id, stage.id, dueDate]);
    }
  }

  return pathway;
}

/** Advance due_date chain: when a stage completes, any later PENDING stage
 * whose due_date hasn't been set from a due_offset yet gets one, anchored on
 * this stage's completion date. Stages already due (offset already applied at
 * start time) are left alone — only null due_dates on offset-bearing stages
 * are back-filled, so this is safe to call after every completion. */
async function _cascadeDueDates(db, childPathwayId, fromStageOrder, fromDate) {
  const { rows: stages } = await db.query(
    `SELECT cps.id, cps.due_date, ps.stage_order, ps.due_offset_days
       FROM child_pathway_stages cps
       JOIN pathway_stages ps ON ps.id = cps.stage_id
      WHERE cps.child_pathway_id=$1 AND cps.status='pending' AND ps.stage_order > $2
      ORDER BY ps.stage_order`, [childPathwayId, fromStageOrder]);
  let anchor = fromDate;
  for (const s of stages) {
    if (s.due_offset_days == null) break; // event-driven stage — stop the chain here
    const existing = toYmd(s.due_date);
    if (existing) { anchor = existing; continue; } // already has a due date, keep chaining from it
    const d = new Date(anchor + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + s.due_offset_days);
    const dueDate = d.toISOString().slice(0, 10);
    await db.query(`UPDATE child_pathway_stages SET due_date=$1, updated_at=now() WHERE id=$2`, [dueDate, s.id]);
    anchor = dueDate;
  }
}

async function completeStage(db, { childPathwayStageId, staffId, notes, evidenceTable, evidenceId, evidenceNote }) {
  const { rows } = await db.query(
    `UPDATE child_pathway_stages
        SET status='done', done_at=now(), done_by=$2, notes=COALESCE($3, notes),
            evidence_table=$4, evidence_id=$5, evidence_note=$6, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [childPathwayStageId, staffId || null, notes || null, evidenceTable || null, evidenceId || null, evidenceNote || null]);
  const row = rows[0];
  if (!row) throw new Error('Stage not found');

  const { rows: ps } = await db.query(
    `SELECT stage_order FROM pathway_stages WHERE id=$1`, [row.stage_id]);
  if (ps[0]) {
    await _cascadeDueDates(db, row.child_pathway_id, ps[0].stage_order, new Date().toISOString().slice(0, 10));
  }
  return row;
}

async function skipStage(db, { childPathwayStageId, staffId, notes }) {
  const { rows: check } = await db.query(
    `SELECT cps.*, ps.can_skip, ps.stage_order FROM child_pathway_stages cps
       JOIN pathway_stages ps ON ps.id = cps.stage_id WHERE cps.id=$1`, [childPathwayStageId]);
  const row = check[0];
  if (!row) throw new Error('Stage not found');
  if (!row.can_skip) throw new Error('This stage is not one that can be skipped — record what happened instead');

  const { rows } = await db.query(
    `UPDATE child_pathway_stages SET status='not_applicable', notes=COALESCE($2, notes), updated_at=now(),
            done_at=now(), done_by=$3
      WHERE id=$1 RETURNING *`,
    [childPathwayStageId, notes || null, staffId || null]);
  await _cascadeDueDates(db, row.child_pathway_id, row.stage_order, new Date().toISOString().slice(0, 10));
  return rows[0];
}

async function closePathway(db, { childPathwayId, staffId, reason }) {
  const { rows } = await db.query(
    `UPDATE child_pathways SET status='closed', closed_at=now(), closed_by=$2, close_reason=$3
      WHERE id=$1 RETURNING *`, [childPathwayId, staffId || null, reason || null]);
  if (!rows.length) throw new Error('Pathway not found');
  return rows[0];
}

/** All pathways (default: open only) for one child, with stages + computed status. */
async function childPathways(db, childId, { includeClosedStatus } = {}) {
  const statusFilter = includeClosedStatus ? '' : `AND cp.status='open'`;
  const { rows: pathways } = await db.query(
    `SELECT cp.*, t.key AS template_key, t.label AS template_label
       FROM child_pathways cp JOIN pathway_templates t ON t.id = cp.template_id
      WHERE cp.child_id=$1 ${statusFilter}
      ORDER BY cp.started_at DESC`, [childId]);
  if (!pathways.length) return [];

  const ids = pathways.map(p => p.id);
  const { rows: stages } = await db.query(
    `SELECT cps.*, ps.key AS stage_key, ps.stage_order, ps.title, ps.what_must_happen, ps.owner_role, ps.evidence_type,
            ps.can_skip, ps.is_statutory, ps.citation,
            st.first_name || ' ' || st.last_name AS done_by_name
       FROM child_pathway_stages cps
       JOIN pathway_stages ps ON ps.id = cps.stage_id
       LEFT JOIN staff st ON st.id = cps.done_by
      WHERE cps.child_pathway_id = ANY($1::integer[])
      ORDER BY ps.stage_order`, [ids]);

  const today = new Date();
  const byPathway = new Map();
  for (const s of stages) {
    if (!byPathway.has(s.child_pathway_id)) byPathway.set(s.child_pathway_id, []);
    byPathway.get(s.child_pathway_id).push({ ...s, effective_status: effectiveStatus(s, today) });
  }
  return pathways.map(p => ({ ...p, stages: byPathway.get(p.id) || [] }));
}

/** Overdue/due-soon stages across every open pathway, for the manager digest. */
async function overdueStagesSummary(db) {
  const { rows } = await db.query(
    `SELECT cps.id, cps.due_date, cps.status,
            c.id AS child_id, c.first_name || ' ' || c.last_name AS child_name,
            t.label AS template_label, ps.title AS stage_title, ps.is_statutory
       FROM child_pathway_stages cps
       JOIN child_pathways cp ON cp.id = cps.child_pathway_id AND cp.status='open'
       JOIN children c ON c.id = cp.child_id
       JOIN pathway_templates t ON t.id = cp.template_id
       JOIN pathway_stages ps ON ps.id = cps.stage_id
      WHERE cps.status='pending' AND cps.due_date IS NOT NULL
      ORDER BY cps.due_date`);
  const today = new Date();
  const overdue = [], dueSoon = [];
  for (const r of rows) {
    const eff = effectiveStatus({ status: r.status, due_date: r.due_date }, today);
    if (eff === 'overdue') overdue.push(r);
    else if (eff === 'due_soon') dueSoon.push(r);
  }
  return { overdue, dueSoon };
}

module.exports = {
  effectiveStatus, templateStages, startPathway, completeStage, skipStage, closePathway,
  childPathways, overdueStagesSummary, GRACE_DAYS, toYmd,
};
