'use strict';
/**
 * framework-compliance.js — b231 (2026-08-25). Mounted at /api/framework-compliance.
 *
 * "Is our policy checker up and running?" — this is the read side of the answer.
 *
 * The EYFS statutory framework changes on 1 September 2026. Wren has always
 * WATCHED gov.uk for that (src/routes/legislation.js over the shared
 * public.legislation_watch), but watching only tells you the law moved. These
 * endpoints tell you what it moved TO, and which of the setting's own policies
 * no longer line up with it:
 *
 *   GET  /state              the countdown card — days until the new framework
 *                            applies, and the policy verdict tally behind it.
 *   GET  /diff               statement-level old-vs-new, filterable. Ratios,
 *                            qualifications, safeguarding and learning &
 *                            development sort first: those are the ones that
 *                            change what a nursery actually has to do.
 *   GET  /checks             every active policy with its latest verdict.
 *   GET  /checks/:policyId   one policy's verdict, findings and cited statements.
 *   POST /checks/:id/sign-off   a human accepts or rejects the AI's finding.
 *
 * THE VERDICTS ARE ADVICE, NOT AUTHORITY. They come from a local model reading
 * the policy against retrieved statutory statements (scripts/b231-policy-check.js).
 * Nothing here edits a policy, and every response carries `advisory: true` so a
 * caller cannot render these as settled fact by accident.
 *
 * Manager-gated, matching legislation.js.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const MGR = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);
router.use((req, res, next) =>
  MGR.has(req.user?.role) ? next() : res.status(403).json({ error: 'Manager access required' }));

const FRAMEWORK = 'eyfs_statutory_2026';
const FROM_FRAMEWORK = 'eyfs_statutory_2025';

// Topics in the order Toby asked for them: the requirements that change what
// the setting has to DO come before the ones that change how it is described.
const TOPIC_ORDER = ['ratios', 'qualifications', 'safeguarding', 'learning_development', 'other'];
const TOPIC_LABELS = {
  ratios: 'Ratios & supervision',
  qualifications: 'Qualifications & training',
  safeguarding: 'Safeguarding & welfare',
  learning_development: 'Learning & development',
  other: 'Other',
};

const daysUntil = (iso) => {
  if (!iso) return null;
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.round((new Date(String(iso).slice(0, 10) + 'T00:00:00Z') - today) / 86400000);
};

/** Provenance + effective date, read from what the ingest actually stored. */
async function frameworkMeta(db) {
  const { rows } = await db.query(`
    SELECT count(*)::int AS statements,
           min(metadata->>'effective_from')   AS effective_from,
           min(metadata->>'document_title')   AS document_title,
           min(metadata->>'source_url')       AS source_url,
           min(metadata->>'publication_date') AS publication_date,
           max(metadata->>'retrieved_at')     AS retrieved_at
      FROM framework_statements WHERE framework = $1`, [FRAMEWORK]);
  const m = rows[0] || {};
  return {
    framework: FRAMEWORK,
    statements: m.statements || 0,
    effective_from: m.effective_from || null,
    days_until: daysUntil(m.effective_from),
    document_title: m.document_title || null,
    source_url: m.source_url || null,
    publication_date: m.publication_date || null,
    retrieved_at: m.retrieved_at || null,
  };
}

// Latest check per policy — one row each, newest run wins.
const LATEST_CHECKS = `
  SELECT DISTINCT ON (c.policy_id)
         c.id, c.policy_id, c.verdict, c.statement_code, c.statement_id, c.reason,
         c.findings, c.model, c.checked_at, c.run_id, c.policy_version,
         c.signed_off_by, c.signed_off_at, c.sign_off_note
    FROM policy_framework_checks c
   WHERE c.framework = $1
   ORDER BY c.policy_id, c.checked_at DESC, c.id DESC`;

// GET /state — everything the countdown card needs, in one call.
router.get('/state', async (req, res) => {
  const db = getPool();
  try {
    const meta = await frameworkMeta(db);
    if (!meta.statements) {
      return res.json({
        advisory: true, ready: false, framework: meta,
        message: 'The EYFS 2026 framework has not been ingested yet. ' +
                 'Run scripts/b231-eyfs2026-ingest.py.',
      });
    }

    const { rows: tally } = await db.query(`
      SELECT l.verdict, count(*)::int AS n
        FROM (${LATEST_CHECKS}) l
        JOIN policies p ON p.id = l.policy_id AND p.is_active = true
       GROUP BY l.verdict`, [FRAMEWORK]);
    const verdicts = { ok: 0, needs_review: 0, must_change: 0, error: 0 };
    for (const r of tally) verdicts[r.verdict] = r.n;

    const { rows: pol } = await db.query(
      `SELECT count(*)::int AS active,
              count(*) FILTER (WHERE review_due = $1::date)::int AS due_on_effective
         FROM policies WHERE is_active = true`, [meta.effective_from]);

    const { rows: diff } = await db.query(`
      SELECT change_type, significance, count(*)::int AS n
        FROM framework_diffs
       WHERE to_framework = $1 AND from_framework = $2
       GROUP BY 1, 2`, [FRAMEWORK, FROM_FRAMEWORK]);
    const changes = { added: 0, removed: 0, reworded: 0, material: 0, minor: 0 };
    for (const r of diff) {
      changes[r.change_type] = (changes[r.change_type] || 0) + r.n;
      changes[r.significance] = (changes[r.significance] || 0) + r.n;
    }

    const { rows: byTopic } = await db.query(`
      SELECT topic, count(*)::int AS n
        FROM framework_diffs
       WHERE to_framework = $1 AND from_framework = $2 AND significance = 'material'
       GROUP BY 1`, [FRAMEWORK, FROM_FRAMEWORK]);

    const { rows: last } = await db.query(`
      SELECT max(checked_at) AS checked_at, count(DISTINCT run_id)::int AS runs
        FROM policy_framework_checks WHERE framework = $1`, [FRAMEWORK]);

    const checked = verdicts.ok + verdicts.needs_review + verdicts.must_change + verdicts.error;
    res.json({
      advisory: true,
      ready: true,
      framework: meta,
      policies: {
        active: pol[0].active,
        checked,
        unchecked: Math.max(0, pol[0].active - checked),
        due_on_effective: pol[0].due_on_effective,
      },
      verdicts,
      changes,
      material_by_topic: TOPIC_ORDER
        .map(t => ({ topic: t, label: TOPIC_LABELS[t], n: (byTopic.find(r => r.topic === t) || {}).n || 0 }))
        .filter(r => r.n),
      last_checked_at: last[0].checked_at,
      check_runs: last[0].runs,
      // Said plainly so no caller renders an AI verdict as a compliance guarantee.
      disclaimer: 'AI-assisted findings from a local model, checked against the published ' +
                  'statutory text. They are advice for a human reviewer, not a compliance ' +
                  'sign-off, and no policy has been edited.',
    });
  } catch (e) {
    console.error('framework-compliance/state:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /diff — old vs new. ?topic= &significance= &change_type= &q= &limit=
router.get('/diff', async (req, res) => {
  const db = getPool();
  try {
    const where = ['to_framework = $1', 'from_framework = $2'];
    const vals = [FRAMEWORK, FROM_FRAMEWORK];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace('$?', '$' + vals.length)); };

    if (req.query.topic) add('topic = $?', String(req.query.topic));
    if (req.query.significance) add('significance = $?', String(req.query.significance));
    if (req.query.change_type) add('change_type = $?', String(req.query.change_type));
    if (req.query.q) {
      vals.push(`%${String(req.query.q)}%`);
      where.push(`(new_text ILIKE $${vals.length} OR old_text ILIKE $${vals.length}
                   OR statement_code ILIKE $${vals.length})`);
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const { rows } = await db.query(`
      SELECT id, change_type, statement_code, old_statement_code, area, aspect,
             old_text, new_text, similarity, significance, topic
        FROM framework_diffs
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE significance WHEN 'material' THEN 0 ELSE 1 END,
         array_position($${vals.length + 1}::text[], topic),
         CASE change_type WHEN 'added' THEN 0 WHEN 'removed' THEN 1 ELSE 2 END,
         similarity NULLS FIRST,
         statement_code
       LIMIT ${limit}`, [...vals, TOPIC_ORDER]);

    res.json({
      advisory: false,   // the diff itself is deterministic — no model involved
      from_framework: FROM_FRAMEWORK, to_framework: FRAMEWORK,
      topic_labels: TOPIC_LABELS,
      count: rows.length, changes: rows,
    });
  } catch (e) {
    console.error('framework-compliance/diff:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /checks — every active policy with its latest verdict. ?verdict= filter.
router.get('/checks', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT p.id AS policy_id, p.title, p.category, p.version, p.review_due,
             l.id AS check_id, l.verdict, l.statement_code, l.reason, l.findings,
             l.model, l.checked_at, l.run_id,
             l.signed_off_by, l.signed_off_at, l.sign_off_note,
             (s.first_name || ' ' || s.last_name) AS signed_off_name,
             fs.statement_text
        FROM policies p
        LEFT JOIN (${LATEST_CHECKS}) l ON l.policy_id = p.id
        LEFT JOIN staff s ON s.id = l.signed_off_by
        LEFT JOIN framework_statements fs ON fs.id = l.statement_id
       WHERE p.is_active = true
       ORDER BY CASE l.verdict WHEN 'must_change' THEN 0 WHEN 'needs_review' THEN 1
                               WHEN 'error' THEN 2 WHEN 'ok' THEN 3 ELSE 4 END,
                p.title`, [FRAMEWORK]);

    const filtered = req.query.verdict
      ? rows.filter(r => r.verdict === req.query.verdict)
      : rows;

    res.json({
      advisory: true, framework: FRAMEWORK,
      count: filtered.length, policies: filtered,
      disclaimer: 'AI-assisted. Every must_change needs a human sign-off before action.',
    });
  } catch (e) {
    console.error('framework-compliance/checks:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /checks/:policyId — one policy, with the statements its findings cite
// and the full history of checks against it.
router.get('/checks/:policyId', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.policyId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad policy id' });
  try {
    const { rows: pol } = await db.query(
      `SELECT id, title, category, version, review_due FROM policies WHERE id = $1`, [id]);
    if (!pol.length) return res.status(404).json({ error: 'Policy not found' });

    const { rows: history } = await db.query(`
      SELECT id, run_id, verdict, statement_code, reason, findings, model, checked_at,
             signed_off_by, signed_off_at, sign_off_note
        FROM policy_framework_checks
       WHERE policy_id = $1 AND framework = $2
       ORDER BY checked_at DESC, id DESC LIMIT 20`, [id, FRAMEWORK]);

    // Resolve every statement code the latest check cites, so the UI can show
    // the actual statutory wording rather than just a paragraph number.
    const latest = history[0] || null;
    const codes = latest
      ? [...new Set([latest.statement_code, ...(latest.findings || []).map(f => f.statement_code)]
          .filter(Boolean))]
      : [];
    let statements = [];
    if (codes.length) {
      ({ rows: statements } = await db.query(`
        SELECT fs.statement_code, fs.area, fs.aspect, fs.statement_text,
               d.change_type, d.significance, d.topic, d.old_text, d.old_statement_code
          FROM framework_statements fs
          LEFT JOIN framework_diffs d
            ON d.to_framework = fs.framework AND d.statement_code = fs.statement_code
           AND d.change_type <> 'removed'
         WHERE fs.framework = $1 AND fs.statement_code = ANY($2::text[])
         ORDER BY fs.statement_code`, [FRAMEWORK, codes]));
    }

    res.json({ advisory: true, policy: pol[0], latest, history, statements });
  } catch (e) {
    console.error('framework-compliance/checks/:id:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /checks/:id/sign-off — the human decision on an AI finding.
// { accepted: bool, note?: string }. Recorded, never inferred: an unsigned
// must_change stays outstanding for as long as nobody has looked at it.
router.post('/checks/:id/sign-off', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad check id' });
  const { accepted, note } = req.body || {};
  if (typeof accepted !== 'boolean') {
    return res.status(400).json({ error: 'accepted (boolean) required' });
  }
  try {
    const prefix = accepted ? 'ACCEPTED' : 'REJECTED';
    const { rows } = await db.query(`
      UPDATE policy_framework_checks
         SET signed_off_by = $1, signed_off_at = now(),
             sign_off_note = $2
       WHERE id = $3
       RETURNING id, policy_id, verdict, signed_off_by, signed_off_at, sign_off_note`,
      [req.user.id, `${prefix}: ${String(note || '').slice(0, 500)}`.trim(), id]);
    if (!rows.length) return res.status(404).json({ error: 'Check not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('framework-compliance sign-off:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── b236 — the EYFS 2026 draft queue ───────────────────────────────────────
   b231 ended at the verdict. These endpoints carry the next step: the redline
   drafts written against the 2026 text, and Toby's decision on each.

   NOTHING HERE PUBLISHES. /drafts/:id/decide moves a draft to 'accepted',
   'rejected' or 'edited' and writes ladn.policy_drafts only. It does not write
   ladn.policies, it does not bump a version, it does not set published_at. The
   status CHECK constraint has no 'published' and no 'approved' value, so this
   is enforced by the database and not only by this file being careful. */

// GET /drafts — every draft, plus the ranked review queue for the rest.
router.get('/drafts', async (req, res) => {
  const db = getPool();
  try {
    const { rows: drafts } = await db.query(`
      SELECT d.id, d.slug, d.policy_id, d.new_title, d.new_category, d.kind,
             d.statement_codes, d.driver, d.title, d.rationale, d.before_text,
             d.after_text, d.procedure_note, d.confidence, d.model, d.prompt_note,
             d.sort_order, d.status, d.decided_at, d.decision_note, d.edited_text,
             p.title AS policy_title, p.category AS policy_category
        FROM policy_drafts d
        LEFT JOIN policies p ON p.id = d.policy_id
       WHERE d.framework = $1
       ORDER BY d.sort_order, d.id`, [FRAMEWORK]);

    // The statutory text behind every citation, so the UI can show the reader
    // the paragraph rather than asking them to trust a code.
    const codes = [...new Set(drafts.flatMap(d => d.statement_codes || []))];
    const { rows: stmts } = codes.length ? await db.query(`
      SELECT fs.statement_code, fs.statement_text, fs.area,
             fd.change_type, fd.old_statement_code, fd.old_text
        FROM framework_statements fs
        LEFT JOIN framework_diffs fd
               ON fd.to_framework = fs.framework
              AND fd.statement_code = fs.statement_code
              AND fd.change_type <> 'removed'
       WHERE fs.framework = $1 AND fs.statement_code = ANY($2)`,
      [FRAMEWORK, codes]) : { rows: [] };

    const { rows: queue } = await db.query(`
      SELECT r.policy_id, r.verdict, r.statement_code, r.delta_class,
             r.delta_score, r.gap_score, r.score, r.shortlist, r.headline,
             p.title, p.category
        FROM policy_review_ranking r
        JOIN policies p ON p.id = r.policy_id
       WHERE r.framework = $1
         AND r.run_id = (SELECT run_id FROM policy_review_ranking
                          WHERE framework = $1 ORDER BY created_at DESC LIMIT 1)
       ORDER BY r.score DESC, r.policy_id`, [FRAMEWORK]);

    res.json({
      framework: FRAMEWORK,
      drafts,
      statements: Object.fromEntries(stmts.map(r => [r.statement_code, r])),
      queue,
      counts: drafts.reduce((m, d) => (m[d.status] = (m[d.status] || 0) + 1, m), {}),
      // Said in the payload as well as in the UI, so an API consumer cannot
      // mistake an accepted draft for an approved policy.
      disclaimer: 'These are drafts for approval. Accepting one stages it — it does not '
        + 'change, version or publish the policy. Every draft is marked "verify with '
        + 'Ofsted/LA" until a human confirms it.',
    });
  } catch (e) {
    console.error('framework-compliance drafts:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /review-queue — the ranked "other 52", shortlist first.
router.get('/review-queue', async (req, res) => {
  const db = getPool();
  const shortlistOnly = String(req.query.shortlist || '') === '1';
  try {
    const { rows } = await db.query(`
      SELECT r.policy_id, r.verdict, r.statement_code, r.delta_class,
             r.delta_score, r.gap_score, r.score, r.shortlist, r.headline, r.evidence,
             p.title, p.category
        FROM policy_review_ranking r
        JOIN policies p ON p.id = r.policy_id
       WHERE r.framework = $1
         AND r.run_id = (SELECT run_id FROM policy_review_ranking
                          WHERE framework = $1 ORDER BY created_at DESC LIMIT 1)
         AND ($2::boolean IS NOT TRUE OR r.shortlist)
       ORDER BY r.score DESC, r.policy_id`, [FRAMEWORK, shortlistOnly]);
    res.json({
      count: rows.length,
      shortlisted: rows.filter(r => r.shortlist).length,
      rule: 'Shortlisted when the 2026 framework actually changed the obligation '
          + '(delta_class new_requirement, obligation_change or removed) OR the checker '
          + 'returned must_change. delta_class comes from a word-level diff of the old '
          + 'and new paragraph, not from the ingest’s coarse significance flag.',
      items: rows,
    });
  } catch (e) {
    console.error('framework-compliance review-queue:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /drafts/:id/decide — { decision: 'accepted'|'rejected'|'edited', note?, text? }
// 'edited' stores what the human typed in edited_text and leaves after_text as
// the record of what the model proposed. Both are kept: overwriting the model's
// wording would lose the provenance that makes the draft auditable.
router.post('/drafts/:id/decide', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad draft id' });
  const { decision, note, text } = req.body || {};
  if (!['accepted', 'rejected', 'edited'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'accepted', 'rejected' or 'edited'" });
  }
  if (decision === 'edited' && !String(text || '').trim()) {
    return res.status(400).json({ error: 'text required when decision is edited' });
  }
  try {
    const { rows } = await db.query(`
      UPDATE policy_drafts
         SET status = $1, decided_by = $2, decided_at = now(),
             decision_note = $3,
             -- Only an 'edited' decision carries replacement text; COALESCE keeps
             -- whatever was there for the other two. Deciding this in JS rather
             -- than a CASE avoids Postgres having to deduce one parameter as both
             -- the status column's varchar and a text comparand.
             edited_text = COALESCE($4, edited_text),
             updated_at = now()
       WHERE id = $5
       RETURNING id, slug, status, decided_at, decision_note, edited_text`,
      [decision, req.user.id, String(note || '').slice(0, 1000) || null,
       decision === 'edited' ? String(text).slice(0, 60000) : null, id]);
    if (!rows.length) return res.status(404).json({ error: 'Draft not found' });
    res.json({ ...rows[0], staged_only: true });
  } catch (e) {
    console.error('framework-compliance decide:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /drafts/:id/reopen — undo a decision, back to 'draft'.
router.post('/drafts/:id/reopen', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad draft id' });
  try {
    const { rows } = await db.query(`
      UPDATE policy_drafts
         SET status = 'draft', decided_by = NULL, decided_at = NULL,
             decision_note = NULL, updated_at = now()
       WHERE id = $1 RETURNING id, slug, status`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Draft not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('framework-compliance reopen:', e.message);
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;
