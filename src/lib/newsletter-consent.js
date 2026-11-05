'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b263 — the consent gate for parent newsletters.
//
// WHY THIS FILE EXISTS, AND WHY IT IS FAIL-CLOSED
//   Across 247 children on prod, exactly ONE has a photo consent recorded, and
//   the canonical store (ladn.child_consents) has ZERO rows with granted=true:
//
//     children.photo_consent   246 false · 1 true     children.media_consent  all false
//     child_consents           92 rows (46 photo_media, 46 marketing_face) — all granted=false
//
//   That is almost certainly a migration gap — EyLog held these and they did not
//   come across — rather than 246 families having said no. But "probably fine on
//   paper" is not a lawful basis. A newsletter with children's faces going to 82
//   addresses needs a recorded permission per child, or it does not go.
//
//   So: every photo, name and direct quote of a child is gated here, per child,
//   at render time. There is NO override flag and NO "include anyway" argument.
//   A newsletter containing an unconsented child is not discouraged, it is
//   unrepresentable — the ungated child never reaches the section in the first
//   place.
//
// ── WHY THE CANONICAL TABLE ONLY, NOT THE LEGACY COLUMN ──────────────────────
//   src/routes/consents.js dual-writes children.photo_consent from
//   child_consents, so canonical ⊇ legacy for anything set since that route
//   shipped. The reverse is not true: a stale legacy `true` with no consent row
//   behind it is a value with no provenance — no consent_date, no source, no
//   updated_by, nothing to show an inspector. wren_dev has exactly one such row.
//   Reading the legacy column would let that one child through on the strength
//   of a boolean nobody can account for, which is the whole failure mode this
//   gate exists to prevent. A granted row, or nothing.
//
// ── WHICH CONSENT TYPE ───────────────────────────────────────────────────────
//   photo_media ("photos/videos used in their learning journey, daily diary,
//   displays and records — kept within the nursery"), not marketing_face
//   ("website, social media or printed marketing"). A newsletter to the setting's
//   own enrolled families is a nursery communication, not marketing: it is not
//   published, not public, and goes only to people who already have a child on
//   roll. marketing_face would be the gate for anything that leaves that circle.
//   One constant, one place to change it if Toby reads it the other way.
// ─────────────────────────────────────────────────────────────────────────────

// The consent type a child must have GRANTED to appear by photo, name or quote.
const NEWSLETTER_CONSENT_TYPE = 'photo_media';

// The type that would additionally be required for anything published beyond the
// parent body. Not used by the newsletter path; named so the distinction above is
// legible in code rather than only in this comment.
const PUBLIC_CONSENT_TYPE = 'marketing_face';

/**
 * The set of child ids that may be named/shown in a newsletter.
 * Fail-closed: any error returns an EMPTY set, so a database wobble hides
 * children rather than exposing them.
 * @returns {Promise<Set<number>>}
 */
async function consentedChildIds(db) {
  try {
    const { rows } = await db.query(
      `SELECT child_id FROM child_consents
        WHERE consent_type = $1 AND granted IS TRUE`,
      [NEWSLETTER_CONSENT_TYPE]
    );
    return new Set(rows.map(r => Number(r.child_id)));
  } catch (e) {
    console.error('[b263 consent] consentedChildIds failed — failing closed:', e.message);
    return new Set();
  }
}

/**
 * Split a list of child-shaped rows into what may be shown and what may not.
 * `rows` need only carry an id under `idKey` (default 'id').
 *
 * Returns { allowed, hidden, hiddenCount, reason } — `hidden` is retained ONLY
 * so a caller can count and describe it. It carries ids, never names: nothing
 * downstream can accidentally render it (see the b-batch "counts only on every
 * write path" rule).
 */
function splitByConsent(rows, allowedIds, idKey = 'id') {
  const allowed = [];
  const hiddenIds = [];
  for (const r of rows || []) {
    if (allowedIds.has(Number(r[idKey]))) allowed.push(r);
    else hiddenIds.push(Number(r[idKey]));
  }
  return {
    allowed,
    hiddenIds,
    hiddenCount: hiddenIds.length,
    reason: hiddenIds.length ? 'no photo consent recorded' : null,
  };
}

/**
 * The gap itself, for the compose screen and the attention item.
 * Toby cannot fix what he cannot see — this is the number that makes the
 * migration gap visible rather than silently swallowed.
 */
async function consentGap(db) {
  try {
    const { rows } = await db.query(`
      SELECT
        (SELECT count(*) FROM children WHERE is_active = true)                       AS active_children,
        (SELECT count(*) FROM children WHERE is_active = true AND id IN (
            SELECT child_id FROM child_consents
             WHERE consent_type = $1 AND granted IS TRUE))                            AS consented,
        (SELECT count(*) FROM children WHERE is_active = true AND id IN (
            SELECT child_id FROM child_consents
             WHERE consent_type = $1 AND granted IS FALSE))                           AS refused,
        (SELECT count(*) FROM children WHERE is_active = true AND photo_consent IS TRUE
            AND id NOT IN (SELECT child_id FROM child_consents
                            WHERE consent_type = $1 AND granted IS TRUE))             AS legacy_only
    `, [NEWSLETTER_CONSENT_TYPE]);
    const r = rows[0] || {};
    const active    = Number(r.active_children || 0);
    const consented = Number(r.consented || 0);
    const refused   = Number(r.refused || 0);
    const legacyOnly = Number(r.legacy_only || 0);
    const unrecorded = Math.max(0, active - consented - refused);
    return {
      consent_type: NEWSLETTER_CONSENT_TYPE,
      active_children: active,
      consented,
      refused,
      unrecorded,
      // A stale legacy boolean with no consent row behind it. Deliberately NOT
      // treated as consent — surfaced so the discrepancy is visible.
      legacy_only_not_honoured: legacyOnly,
      // The headline for the attention item.
      message: unrecorded
        ? `${unrecorded} ${unrecorded === 1 ? 'child has' : 'children have'} no photo consent recorded`
        : null,
      blocking: consented === 0,
      blocking_message: consented === 0
        ? 'No child has a granted photo consent, so no child can be named or shown in a newsletter yet.'
        : null,
    };
  } catch (e) {
    console.error('[b263 consent] consentGap failed:', e.message);
    return {
      consent_type: NEWSLETTER_CONSENT_TYPE,
      active_children: 0, consented: 0, refused: 0, unrecorded: 0,
      legacy_only_not_honoured: 0,
      message: 'Consent status could not be read — treating every child as unconsented.',
      blocking: true,
      blocking_message: 'Consent status could not be read — treating every child as unconsented.',
    };
  }
}


// ── The render-time gate ─────────────────────────────────────────────────────
// Assembly filters by consent, but assembly is not when the newsletter goes out.
// A family can withdraw consent between composing on Monday and sending on
// Friday, and the assembled section carries a snapshot taken on Monday. Storing
// a snapshot and rendering it unchecked is exactly how a withdrawn consent still
// ends up in an inbox.
//
// So this runs again immediately before EVERY render — preview, export, render,
// and both send paths. It re-reads child_consents and drops any item whose child
// is no longer granted, re-counting `consent_hidden` so the number the compose
// screen shows stays true rather than being a Monday figure shown on Friday.
//
// Fail-closed: consentedChildIds() returns an empty set on error, so a database
// wobble empties the child-naming sections rather than passing them through.
//
// Sections are cloned, never mutated in place — the caller's rows may be written
// back to the database elsewhere and must not silently acquire a filtered list.
async function regateSectionsForRender(db, sections) {
  const list = sections || [];
  // Only sections that actually name a child need the round-trip.
  const needsGate = list.some(s => CHILD_NAMING_TYPES.has(s.section_type));
  if (!needsGate) return list;

  const allowed = await consentedChildIds(db);
  return list.map(s => {
    if (!CHILD_NAMING_TYPES.has(s.section_type)) return s;
    const meta = s.metadata || {};
    const items = Array.isArray(meta.items) ? meta.items : [];
    const kept = items.filter(i => allowed.has(Number(i.id)));
    const dropped = items.length - kept.length;
    if (!dropped) return s;
    console.warn(`[b263 consent] render gate dropped ${dropped} child item(s) from `
               + `section ${s.id} (${s.section_type}) — consent no longer granted`);
    return {
      ...s,
      metadata: {
        ...meta,
        items: kept,
        consent_hidden: Number(meta.consent_hidden || 0) + dropped,
        consent_reason: 'no photo consent recorded',
        regated_at_render: true,
      },
    };
  });
}

// Section types whose metadata.items carry a child id.
const CHILD_NAMING_TYPES = new Set(['new_starters']);

module.exports = {
  NEWSLETTER_CONSENT_TYPE,
  CHILD_NAMING_TYPES,
  regateSectionsForRender,
  PUBLIC_CONSENT_TYPE,
  consentedChildIds,
  splitByConsent,
  consentGap,
};
