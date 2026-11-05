'use strict';
/**
 * family-access.js — "this family cannot see their child" (2026-09-21)
 *
 * A parent signs in (Cloudflare lets any allowlisted address through), Wren looks up
 * their children by email, finds none, and tells them we cannot find their child.
 * On 2026-09-21 that was true for NINE children on roll, and the way we found out
 * was a parent saying so at the door.
 *
 * Portal access is created by the online registration flow. A child added by hand in
 * Roost, or brought in by the EyLog import, never gets it — and nothing ever said so.
 * Two cards:
 *
 *   1. A child on roll whose family has no active portal access at all. Red: they
 *      cannot see the diary, the photos or an invoice, and they will assume it is
 *      broken rather than unset.
 *   2. A child on roll with no email recorded anywhere — the office has to ask the
 *      family before anything can be fixed. Amber: it is a collection job.
 *
 * CONTENT: child ids and counts only, like every collector here. Never a name, never
 * an address — the card links to the profile, where the access checks live.
 */
const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'family-access';

async function collect() {
  const db = getPool();
  const items = [];

  const { rows } = await db.query(`
    SELECT c.id AS child_id,
           to_char(c.start_date, 'YYYY-MM-DD') AS start_date,
           (c.start_date IS NOT NULL AND c.start_date > CURRENT_DATE) AS not_started_yet,
           EXISTS (
             SELECT 1 FROM contacts ct
              WHERE c.id = ANY(ct.child_ids)
                AND COALESCE(btrim(ct.primary_email), '') <> ''
           ) OR COALESCE(btrim(c.parent_1_email), '') <> ''
             OR COALESCE(btrim(c.parent_2_email), '') <> '' AS have_an_email
      FROM children c
     WHERE c.is_active
       AND NOT EXISTS (SELECT 1 FROM parent_portal_access p
                        WHERE p.child_id = c.id AND p.is_active)
     ORDER BY c.start_date NULLS LAST`);

  for (const r of rows) {
    // A child who has not started yet is not a family sitting in front of a blank app.
    const started = !r.not_started_yet;
    const c = classify({ blockedOnToby: true, urgent: started && r.have_an_email });
    items.push({
      source: SOURCE,
      source_key: `no-access-${r.child_id}`,
      title: r.have_an_email
        ? 'This family cannot see their child in the app'
        : 'No email on file for this family, so they cannot be given access',
      detail: r.have_an_email
        ? `Child ${r.child_id}${r.start_date ? `, started ${r.start_date}` : ''} has no parent-portal access. `
          + 'We hold an email for them — open the profile and give the family access. '
          + 'Until then they sign in and are told we cannot find their child.'
        : `Child ${r.child_id}${r.start_date ? `, started ${r.start_date}` : ''} has no email recorded anywhere, `
          + 'so there is nothing to give access to. Ask the family at drop-off, add it to the profile, then grant access.',
      why: c.why,
      rag: started ? (r.have_an_email ? 'red' : 'amber') : 'amber',
      category: 'family',
      due_date: null,
      blocked_on: r.have_an_email ? 'toby' : 'external',
      effort_minutes: 5,
      action_url: `/child-profile.html?id=${r.child_id}#family`,
      evidence: { child_id: r.child_id, table: 'parent_portal_access', have_an_email: !!r.have_an_email },
      sort_hint: 1,
    });
  }

  // The runner reads { ok, items } and treats a bare array as a skip — which is the second
  // reason this collector's cards never reached the board.
  return { ok: true, items };
}

// 2026-09-23 — the runner keys every collector off `name` and clears stale rows via `owns`.
// This exported neither, so it showed as "undefined SKIP" in every refresh since it was written
// on 21 September and its cards never reached the board — which is why pressing Recheck never
// changed the number.
module.exports = { name: SOURCE, owns: [SOURCE], collect, SOURCE };
