'use strict';
/**
 * compliance.js — b232 collector. Policy review dates and the EYFS 2026
 * framework verdicts.
 *
 * TWO sources of truth, deliberately joined here:
 *
 *  1. ladn.policies.review_due          — when each policy is next due a look.
 *  2. ladn.policy_framework_checks      — b231's per-policy verdict against the
 *                                         2026 statutory framework.
 *
 * ── WHY THE must_change ITEMS REUSE b236's KEYS ─────────────────────────────
 * b236 already writes one RED per unsigned must_change under
 * source='eyfs2026', source_key='policy-<id>-must-change'. This collector emits
 * the SAME keys rather than its own, so the two upserts land on the same row.
 * b236 keeps its title, detail and deadline; b232 adds the fields it needs
 * (category, effort, why, blocked_on). Emitting a parallel 'compliance' key
 * would have shown Toby every must-change policy twice.
 *
 * ── WHY THE 14-DAY BATCH IS ONE CARD ────────────────────────────────────────
 * 56 policies fall due on 2026-09-01 together — they were re-dated as one batch
 * for the EYFS 2026 deadline. As 56 cards that is not a board, it is a wall, and
 * a wall is the thing this build exists to prevent. Individually-dated overdue
 * policies get a card each; a same-day batch gets one card with the count.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'compliance';
const EYFS_SOURCE = 'eyfs2026';
const EYFS_FRAMEWORK = 'eyfs_statutory_2026';
const POLICIES_URL = '/policies-workspace.html';

async function collect() {
  const db = getPool();
  const items = [];

  // ── 1. unsigned must_change against the 2026 framework ────────────────────
  // Same shape as b236's query: latest check per policy wins.
  const { rows: verdicts } = await db.query(`
    SELECT DISTINCT ON (c.policy_id)
           c.policy_id, c.statement_code, c.verdict, c.signed_off_at, p.title
      FROM policy_framework_checks c
      JOIN policies p ON p.id = c.policy_id
     WHERE c.framework = $1
     ORDER BY c.policy_id, c.checked_at DESC, c.id DESC`, [EYFS_FRAMEWORK]);

  const musts = verdicts.filter(v => v.verdict === 'must_change' && !v.signed_off_at);
  for (const v of musts) {
    // The 2026 framework is statutory and it commences 1 September 2026. That
    // date is not ours to move, so it is the due date and classify() makes it red.
    const c = classify({ statutory: true, dueDate: '2026-09-01' });
    items.push({
      source: EYFS_SOURCE,
      source_key: `policy-${v.policy_id}-must-change`,
      title: `EYFS 2026: "${v.title}" is unsigned and marked MUST CHANGE`,
      detail: `The 2026 framework check cited paragraph ${v.statement_code || '(none)'} and nobody has signed the finding off. `
            + `A draft revision is waiting in the EYFS 2026 queue on the Policies page. Accepting a draft stages it for your approval; it does not publish it.`,
      why: c.why,
      rag: c.rag,
      category: 'compliance',
      due_date: '2026-09-01',
      blocked_on: 'toby',
      effort_minutes: 10,
      action_url: `${POLICIES_URL}#eyfs2026`,
      evidence: { policy_id: v.policy_id, statement_code: v.statement_code, framework: EYFS_FRAMEWORK, verdict: 'must_change' },
      sort_hint: 0,
    });
  }

  // needs_review is a softer verdict — b231 says "look at this", not "this is
  // wrong". One rolled-up amber, not 53 cards.
  const needsReview = verdicts.filter(v => v.verdict === 'needs_review' && !v.signed_off_at);
  if (needsReview.length) {
    const c = classify({ statutory: true, dueDate: '2026-09-01' });
    items.push({
      source: SOURCE,
      source_key: 'eyfs2026-needs-review-batch',
      title: `${needsReview.length} policies flagged "needs review" against EYFS 2026`,
      detail: `The framework checker could not confirm these against the 2026 statutory text. They are not known to be wrong — nobody has read them yet. `
            + `Working through them is the difference between an inspection you walk into and one you brace for.`,
      why: c.why,
      rag: c.rag,
      category: 'compliance',
      due_date: '2026-09-01',
      blocked_on: 'toby',
      effort_minutes: Math.min(240, needsReview.length * 4),
      action_url: `${POLICIES_URL}#eyfs2026`,
      evidence: { count: needsReview.length, policy_ids: needsReview.map(v => v.policy_id).slice(0, 60), framework: EYFS_FRAMEWORK },
      sort_hint: 1,
    });
  }

  // ── 2. review_due ─────────────────────────────────────────────────────────
  const { rows: overdue } = await db.query(`
    SELECT id, title, review_due
      FROM policies
     WHERE is_active AND review_due IS NOT NULL AND review_due < CURRENT_DATE
     ORDER BY review_due
     LIMIT 40`);

  // A same-day batch is one card; anything else is its own.
  const byDate = {};
  for (const p of overdue) byDate[iso(p.review_due)] = (byDate[iso(p.review_due)] || 0) + 1;

  for (const p of overdue) {
    if (byDate[iso(p.review_due)] > 3) continue;   // batched below
    const c = classify({ statutory: true, dueDate: p.review_due });
    items.push({
      source: SOURCE,
      source_key: `policy-review-${p.id}`,
      title: `Policy review overdue: "${p.title}"`,
      detail: `Its review date was ${iso(p.review_due)}. Ofsted asks when a policy was last reviewed, and the honest answer is currently a date in the past.`,
      why: c.why,
      rag: c.rag,
      category: 'compliance',
      due_date: iso(p.review_due),
      blocked_on: 'toby',
      effort_minutes: 15,
      action_url: POLICIES_URL,
      evidence: { policy_id: p.id, review_due: iso(p.review_due) },
      sort_hint: 2,
    });
  }
  for (const [d, n] of Object.entries(byDate)) {
    if (n <= 3) continue;
    const c = classify({ statutory: true, dueDate: d });
    items.push({
      source: SOURCE, source_key: `policy-review-batch-${d}`,
      title: `${n} policy reviews fell due on ${d}`,
      detail: 'These were re-dated as one batch, so they come round together. One sitting clears them.',
      why: c.why, rag: c.rag, category: 'compliance', due_date: d,
      blocked_on: 'toby', effort_minutes: Math.min(240, n * 6),
      action_url: POLICIES_URL,
      evidence: { count: n, review_due: d }, sort_hint: 2,
    });
  }

  // Coming up: one card for the whole 14-day window, whatever its size.
  const { rows: soon } = await db.query(`
    SELECT COUNT(*)::int AS n, MIN(review_due) AS first_due
      FROM policies
     WHERE is_active AND review_due >= CURRENT_DATE AND review_due <= CURRENT_DATE + 14`);
  if (soon[0] && soon[0].n > 0) {
    const c = classify({ statutory: true, dueDate: soon[0].first_due });
    items.push({
      source: SOURCE,
      source_key: 'policy-review-due-14d',
      title: `${soon[0].n} polic${soon[0].n === 1 ? 'y is' : 'ies are'} due for review in the next fortnight`,
      detail: `The earliest falls on ${iso(soon[0].first_due)}. Reviewing early costs a morning; reviewing late costs the answer you give an inspector.`,
      why: c.why,
      rag: c.rag,
      category: 'compliance',
      due_date: iso(soon[0].first_due),
      blocked_on: 'toby',
      effort_minutes: Math.min(240, soon[0].n * 5),
      action_url: POLICIES_URL,
      evidence: { count: soon[0].n, first_due: iso(soon[0].first_due) },
      sort_hint: 3,
    });
  }

  // ── 3. b249: mandatory policies nobody has signed ─────────────────────────
  // A policy could not be marked "must be signed" until b249, so nothing
  // chased anyone. The CCTV notification has to be signed by every member of
  // staff BEFORE the cameras are switched on — the ICO's most common criticism
  // of a nursery CCTV system is that staff were never properly consulted, and
  // "we sent it round" is not evidence. This card is the evidence, or its
  // absence.
  //
  // One card per policy, not per person: 18 staff × 2 policies is 36 cards and
  // a wall, which is exactly what this board exists to prevent.
  const { rows: unsigned } = await db.query(`
    SELECT p.id, p.title, p.version, p.version_label,
           COUNT(s.id)::int AS applies_to,
           COUNT(pa.id)::int AS signed
      FROM policies p
      JOIN staff s ON s.is_active = true AND s.role = ANY(p.required_roles)
      LEFT JOIN policy_acknowledgments pa
        ON pa.policy_id = p.id AND pa.staff_id = s.id AND pa.policy_version = p.version
     WHERE p.is_active = true AND p.requires_acknowledgment = true
     GROUP BY p.id
    HAVING COUNT(s.id) > COUNT(pa.id)
     ORDER BY (COUNT(s.id) - COUNT(pa.id)) DESC`);

  for (const u of unsigned) {
    const outstanding = u.applies_to - u.signed;
    // Statutory, and no date of its own: a signature that has not happened is
    // overdue the moment the policy is in force, so classify() is given today.
    const c = classify({ statutory: true, blockedOnToby: true, dueDate: iso(new Date()) });
    items.push({
      source: SOURCE,
      source_key: `policy-unsigned-${u.id}-v${u.version}`,
      title: `${outstanding} of ${u.applies_to} staff have not signed "${u.title}"`,
      detail: `Version ${u.version_label || u.version} is marked as one every member of staff must sign, and `
            + `${outstanding} ${outstanding === 1 ? 'has' : 'have'} not. `
            + `Staff sign it on their own Policies page; who is outstanding is on Roost → Staff → Policies. `
            + `Where this covers CCTV, the signatures have to be in before the cameras are switched on — being `
            + `able to show staff were told, in writing, is the point.`,
      why: c.why,
      rag: c.rag,
      category: 'compliance',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: Math.min(120, outstanding * 3),
      action_url: '/app.html#staff',
      // blocked_on is constrained to toby | claude | external — and chasing the
      // signatures IS Toby's: he is the one who has to be able to show that
      // staff were told, in writing, before the cameras went on.
      evidence: { policy_id: u.id, version: u.version, applies_to: u.applies_to,
                  signed: u.signed, outstanding },
      sort_hint: 1,
    });
  }

  // ── 4. b249: CCTV footage requests, ordered by the clock that matters ─────
  // The statutory deadline to answer is one calendar month. The footage is gone
  // in seven days. So this card counts DAYS OF FOOTAGE LEFT, not days to
  // respond — a board that shows the month would be reassuring and wrong.
  let openReqs = { rows: [] };
  try {
    openReqs = await db.query(`
      SELECT id, reference, status, footage_expires_at, preserve_status, decision,
             GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (footage_expires_at - now())) / 86400))::int AS days_left,
             (footage_expires_at < now()) AS expired
        FROM cctv_footage_requests
       WHERE status <> 'closed'
       ORDER BY footage_expires_at`);
  } catch (e) {
    // The table arrives with b249's migration. On a database that has not had it
    // yet this collector must still report its OTHER findings rather than fail
    // the whole run — a collector that returns ok:false resolves nothing.
    if (!/does not exist/i.test(e.message)) throw e;
  }

  for (const r of openReqs.rows) {
    const undecided = !r.decision;
    // Child safety is in scope here: a CCTV request is usually raised because
    // something happened to a child, and the evidence expires. classify() reads
    // that as red, which is correct — this is the one card that must not be
    // amber on day six.
    const c = classify({ statutory: true, childSafety: undecided && !r.expired,
                         dueDate: iso(r.footage_expires_at) });
    const preserved = r.preserve_status === 'preserved';
    items.push({
      source: SOURCE,
      source_key: `cctv-request-${r.id}`,
      title: r.expired
        ? `CCTV request ${r.reference}: the footage has been overwritten`
        : `CCTV request ${r.reference}: ${r.days_left} day${r.days_left === 1 ? '' : 's'} of footage left`,
      detail: r.expired
        ? 'The recording window has passed and the footage cannot be recovered. The request still needs a '
        + 'decision and a response within one calendar month of when it was made — say plainly that the '
        + 'footage was overwritten and when.'
        : `The recording is overwritten on ${iso(r.footage_expires_at)}. `
        + (preserved
            ? 'A clip has been exported and verified, so the evidence is safe even after that date. '
            : '⚠️ NO CLIP HAS BEEN PRESERVED. Once the window passes there is nothing left to disclose, '
            + 'whatever is decided. ')
        + 'The one-month statutory deadline to respond is not the deadline that matters here.',
      why: c.why,
      rag: c.rag,
      category: 'compliance',
      due_date: iso(r.footage_expires_at),
      blocked_on: 'toby',
      effort_minutes: 20,
      action_url: '/app.html#cameras',
      evidence: { request_id: r.id, reference: r.reference, status: r.status,
                  preserve_status: r.preserve_status, expired: r.expired, days_left: r.days_left },
      sort_hint: 0,
    });
  }

  return { ok: true, items };
}

function iso(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }

module.exports = { name: SOURCE, owns: [SOURCE, EYFS_SOURCE], collect };
