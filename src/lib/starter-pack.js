'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b288 — the new-starter document pack (2026-09-08)
//
// Toby: "a new starter I want to enrol from wren. needs handbook etc sent.
//        I have uploaded the inductions that I do — new staff induction, and
//        Fire induction."
//
// b275 built the spine: an inactive staff row, a 21-day single-use invite, the
// 4-week workbook, and one welcome email a manager explicitly triggers. This
// module is the part that was missing — WHAT the starter is actually sent.
//
// The pack is a table (ladn.starter_pack_documents), not a constant. A manager
// reorders it, retitles it or switches a document off from Roost, and the next
// starter gets the new set with no deploy. Out of the box it holds the three
// documents Toby uploaded:
//
//   employee-handbook    body_html, rendered on the tokened page, needs an ack
//   new-staff-induction  template "New Staff Induction (Manager)"    — 18 points
//   fire-induction       template "New Staff Fire Induction"         — 16 points
//
// WHERE THE SAFETY TEXT LIVES: exactly once, in induction_template_items, as
// the verbatim string Word stored. The document page renders those rows; it
// does not keep a second, prettier copy that could drift from the first.
//
// NOTHING HERE SENDS ANYTHING. There is no timer, no scheduler and no queue in
// this file: the pack is attached to the invite a manager clicks, and to
// nothing else. (wren-docs/decisions/2026-09-08-no-auto-parent-email.md — the
// rule is parents, the discipline is the same.)
// ─────────────────────────────────────────────────────────────────────────────

// Which pack rows count as "content a starter reads", in the order a manager set.
const LIST_SQL = `
  SELECT d.id, d.slug, d.title, d.kind, d.summary, d.external_url, d.source_file,
         d.requires_ack, d.ack_item_id, d.template_id, d.sort_order, d.is_active,
         t.name AS template_name,
         ai.template_id AS ack_template_id, ai.title AS ack_item_title,
         (d.body_html IS NOT NULL) AS has_body,
         (SELECT COUNT(*)::int FROM induction_template_items ti WHERE ti.template_id = d.template_id) AS item_count
    FROM starter_pack_documents d
    LEFT JOIN induction_templates t ON t.id = d.template_id
    LEFT JOIN induction_template_items ai ON ai.id = d.ack_item_id`;

/** Every pack row, active first-class flag included. Manager screen uses this. */
async function allDocuments(db) {
  const { rows } = await db.query(`${LIST_SQL} ORDER BY d.sort_order, d.id`);
  return rows;
}

/** Only what a starter actually receives. */
async function activeDocuments(db) {
  const { rows } = await db.query(`${LIST_SQL} WHERE d.is_active ORDER BY d.sort_order, d.id`);
  return rows;
}

async function documentBySlug(db, slug) {
  const { rows } = await db.query(`${LIST_SQL} WHERE d.slug = $1`, [String(slug || '').slice(0, 120)]);
  return rows[0] || null;
}

async function documentBody(db, id) {
  const { rows } = await db.query('SELECT body_html FROM starter_pack_documents WHERE id = $1', [id]);
  return rows[0]?.body_html || null;
}

/** The checklist behind an induction-kind document, in the setting's own words. */
async function templateItems(db, templateId) {
  if (!templateId) return [];
  const { rows } = await db.query(`
    SELECT id, section, title, description, item_type, sort_order, required
      FROM induction_template_items
     WHERE template_id = $1
     ORDER BY sort_order, id`, [templateId]);
  return rows;
}

/**
 * Give this starter an assignment for every pack document that has a checklist
 * behind it, so "fire induction done" has somewhere to be recorded.
 *
 * Idempotent in the same way POST /starters is: an open assignment on the same
 * template is reused rather than stacked, and the progress rows are ON CONFLICT
 * DO NOTHING. Calling it twice for the same starter changes nothing.
 *
 * Returns [{ document_id, slug, template_id, assignment_id, created }].
 */
async function ensurePackAssignments(db, o = {}) {
  const staffId = Number(o.staffId);
  if (!staffId) throw new Error('ensurePackAssignments: staffId is required');
  const out = [];
  const docs = await activeDocuments(db);
  for (const d of docs) {
    if (!d.template_id) continue;
    if (o.skipTemplateId && Number(d.template_id) === Number(o.skipTemplateId)) continue;
    const { rows: open } = await db.query(`
      SELECT id FROM induction_assignments
       WHERE staff_id = $1 AND template_id = $2 AND status <> 'complete'
       ORDER BY id DESC LIMIT 1`, [staffId, d.template_id]);
    let assignmentId, created = false;
    if (open.length) {
      assignmentId = open[0].id;
    } else {
      const { rows: ins } = await db.query(`
        INSERT INTO induction_assignments
          (staff_id, template_id, assigned_by, room_leader_id, start_date, target_complete_date, status)
        VALUES ($1,$2,$3,$4,$5::date, COALESCE($6::date, ($5::date + interval '28 days')::date), 'in_progress')
        RETURNING id`,
        [staffId, d.template_id, o.assignedBy || null, o.roomLeaderId || null,
          o.startDate || null, o.targetCompleteDate || null]);
      assignmentId = ins[0].id;
      created = true;
    }
    await db.query(`
      INSERT INTO induction_item_progress (assignment_id, item_id, status)
      SELECT $1, ti.id, 'pending'
        FROM induction_template_items ti
       WHERE ti.template_id = $2
      ON CONFLICT (assignment_id, item_id) DO NOTHING`, [assignmentId, d.template_id]);
    out.push({ document_id: d.id, slug: d.slug, template_id: d.template_id, assignment_id: assignmentId, created });
  }
  return out;
}

/**
 * What the manager screen shows, per starter: handbook acknowledged, induction
 * done, fire induction done — with dates.
 *
 * Read entirely off induction_assignments / induction_item_progress. There is no
 * second place a completion is recorded, so nothing can disagree with the
 * workbook a room leader is ticking.
 */
async function packStatusForStaffIds(db, staffIds) {
  const ids = (Array.isArray(staffIds) ? staffIds : [staffIds]).map(Number).filter(Boolean);
  const byStaff = new Map(ids.map(id => [id, []]));
  if (!ids.length) return byStaff;
  const docs = await activeDocuments(db);

  // Three queries for the whole screen, not three per starter.
  const ackItemIds = docs.filter(d => d.requires_ack && d.ack_item_id).map(d => d.ack_item_id);
  const templateIds = docs.filter(d => d.template_id).map(d => d.template_id);

  const acks = new Map();   // `${staffId}:${itemId}` -> progress row
  if (ackItemIds.length) {
    const { rows } = await db.query(`
      SELECT a.staff_id, ip.item_id, ip.status, ip.completed_at, ip.signed_off_at, ip.evidence_note
        FROM induction_item_progress ip
        JOIN induction_assignments a ON a.id = ip.assignment_id
       WHERE ip.item_id = ANY($1::int[]) AND a.staff_id = ANY($2::int[])
       ORDER BY ip.completed_at DESC NULLS LAST, ip.id DESC`, [ackItemIds, ids]);
    for (const r of rows) {
      const k = `${r.staff_id}:${r.item_id}`;
      if (!acks.has(k)) acks.set(k, r);   // ORDER BY put the most complete first
    }
  }

  const progress = new Map();  // `${staffId}:${templateId}` -> aggregate
  if (templateIds.length) {
    const { rows } = await db.query(`
      SELECT a.staff_id, a.template_id, MAX(a.id) AS assignment_id,
             COUNT(ip.id)::int AS total_items,
             COUNT(*) FILTER (WHERE ip.status IN ('done','signed_off'))::int AS done_items,
             MAX(COALESCE(ip.signed_off_at, ip.completed_at)) AS last_at
        FROM induction_assignments a
        LEFT JOIN induction_item_progress ip ON ip.assignment_id = a.id
       WHERE a.staff_id = ANY($1::int[]) AND a.template_id = ANY($2::int[])
       GROUP BY a.staff_id, a.template_id`, [ids, templateIds]);
    for (const r of rows) progress.set(`${r.staff_id}:${r.template_id}`, r);
  }

  for (const id of ids) {
    const list = byStaff.get(id);
    for (const d of docs) {
      const row = {
        document_id: d.id, slug: d.slug, title: d.title, kind: d.kind,
        requires_ack: d.requires_ack, template_id: d.template_id,
        state: 'not started', at: null, done_items: null, total_items: null,
      };
      if (d.requires_ack && d.ack_item_id) {
        const p = acks.get(`${id}:${d.ack_item_id}`);
        const done = !!p && (p.status === 'done' || p.status === 'signed_off');
        row.total_items = 1;
        row.done_items = done ? 1 : 0;
        row.state = done ? (p.status === 'signed_off' ? 'acknowledged (signed off)' : 'acknowledged') : 'pending';
        row.at = done ? (p.completed_at || p.signed_off_at) : null;
        row.note = p?.evidence_note || null;
      } else if (d.template_id) {
        const p = progress.get(`${id}:${d.template_id}`);
        if (p) {
          row.assignment_id = p.assignment_id;
          row.total_items = p.total_items;
          row.done_items = p.done_items;
          const complete = p.total_items > 0 && p.done_items >= p.total_items;
          row.state = complete ? 'done' : (p.done_items > 0 ? 'in progress' : 'not started');
          row.at = complete ? p.last_at : null;
        }
      } else {
        row.state = d.external_url || d.has_body ? 'sent' : 'not started';
      }
      list.push(row);
    }
  }
  return byStaff;
}

async function packStatusForStaff(db, staffId) {
  const m = await packStatusForStaffIds(db, [staffId]);
  return m.get(Number(staffId)) || [];
}

/**
 * The starter ticking "I have read the handbook" from their own tokened page.
 *
 * Deliberately narrow. It will only ever write the ONE progress row named by
 * an active pack document's ack_item_id, on an assignment belonging to the
 * staff id written on the invite. It cannot touch any other item, any other
 * starter, or a row that has already been signed off by a manager.
 */
async function recordAck(db, o = {}) {
  const doc = await documentBySlug(db, o.slug);
  if (!doc) return { ok: false, reason: 'unknown document' };
  if (!doc.is_active) return { ok: false, reason: 'document is not part of the pack' };
  if (!doc.requires_ack || !doc.ack_item_id) return { ok: false, reason: 'this document does not need an acknowledgement' };
  const staffId = Number(o.staffId);
  if (!staffId) return { ok: false, reason: 'no staff record' };

  const { rows: aRows } = await db.query(`
    SELECT a.id FROM induction_assignments a
     WHERE a.staff_id = $1 AND a.template_id = $2
     ORDER BY (a.status <> 'complete') DESC, a.id DESC LIMIT 1`,
    [staffId, doc.ack_template_id]);
  if (!aRows.length) return { ok: false, reason: 'no induction assignment to record against' };

  const { rows } = await db.query(`
    INSERT INTO induction_item_progress (assignment_id, item_id, status, completed_at, evidence_note)
    VALUES ($1, $2, 'done', now(), $3)
    ON CONFLICT (assignment_id, item_id) DO UPDATE SET
      -- a manager's sign-off outranks a self-declaration and is never downgraded
      status        = CASE WHEN induction_item_progress.status = 'signed_off'
                           THEN 'signed_off' ELSE 'done' END,
      completed_at  = COALESCE(induction_item_progress.completed_at, now()),
      evidence_note = COALESCE(induction_item_progress.evidence_note, EXCLUDED.evidence_note)
    RETURNING id, status, completed_at`,
    [aRows[0].id, doc.ack_item_id, String(o.note || 'Acknowledged by the starter from their welcome link').slice(0, 500)]);
  return { ok: true, progress_id: rows[0].id, status: rows[0].status, at: rows[0].completed_at, document: doc.title };
}

/**
 * The links that go in the welcome email. Tokened, so they reach somebody who
 * does not work here yet and cannot pass Cloudflare Access — and only under
 * /onboard/, the one prefix the public nursery site proxies same-origin.
 * (memory/project_starter_onboard_by_email_b275.md)
 */
function documentLinks(docs, publicHost, token) {
  return (docs || []).map(d => ({
    slug: d.slug,
    title: d.title,
    kind: d.kind,
    summary: d.summary,
    item_count: d.item_count || null,
    // b303: ALWAYS the tokened /onboard/ URL, even for a document that lives
    // somewhere else. A pack row with an external_url (the HMRC starter
    // checklist) redirects from that page to its real home, so the invariant
    // this comment claims stays true of every link we send: one prefix, one
    // proxy, one place an open is recorded. Sending the raw external URL
    // skipped both.
    url: `https://${publicHost}/onboard/document?token=${token}&doc=${encodeURIComponent(d.slug)}`,
    external: !!d.external_url,
  }));
}

module.exports = {
  allDocuments,
  activeDocuments,
  documentBySlug,
  documentBody,
  templateItems,
  ensurePackAssignments,
  packStatusForStaff,
  packStatusForStaffIds,
  recordAck,
  documentLinks,
};
