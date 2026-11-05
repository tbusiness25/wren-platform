'use strict';
/**
 * termly-suggestions.js — b359 (2026-09-29)
 *
 * "It can then add suggested resource cards/activities for activities to do at
 *  nursery and what parents can do to support at home."  — Toby, 2026-09-29
 *
 * This file offers the model a POOL of things that really exist, asks it to
 * choose from that pool, and throws away anything it did not choose from the
 * pool. It has no database and no express in it: it is handed rows and returns
 * a validated structure, so it can be unit-tested and so the route that owns the
 * data owns the queries.
 *
 * The rule, inherited word for word from b223's plan-draft.js and worth
 * repeating because it is the whole design:
 *
 *   THE MODEL MAY ONLY CHOOSE AND ARRANGE WHAT IT IS GIVEN.
 *
 * A card slug the model invented, an activity id that is not in the bank, an
 * id that is in the bank but was not in the pool offered for THIS child — each
 * is DROPPED and reported in `dropped`, never quietly kept and never silently
 * turned into a link that 404s in a family's hands.
 *
 * ── THE TWO STORES ──────────────────────────────────────────────────────────
 * Resource cards are FILE-backed, keyed by slug (src/content/resource-cards/*,
 * plus the setting's own mount — see src/routes/resource-cards.js).
 * Activities are ladn.planning_activities, keyed by integer id — the Activity
 * Bank behind /api/activity-bank and /ey/activities, which is the store the
 * b359 "Activities & Resources" page merges and the one observations already
 * reference through linked_activity_ids / home_activity_ids.
 *
 * (ladn.curriculum_activities is a DIFFERENT, smaller store used by b218/b223
 * for room-level planning. Mixing the two would produce ids that resolve to the
 * wrong row, so this file touches only planning_activities and says so here
 * because the next person WILL have to ask.)
 *
 * ── NURSERY vs HOME ─────────────────────────────────────────────────────────
 * Two lists, because they answer different questions and a parent can act on
 * only one of them:
 *   nursery  what we will put out and do here — cards and activities
 *   home     what the family could try — cards and activities too, but filtered
 *            to the ones that need nothing bought and nothing printed, plus the
 *            free-text ideas b246's `at_home` section already writes
 */

// Caps. A termly update with fourteen suggestions on it is a list nobody reads.
const MAX_CARD_POOL      = 40;
const MAX_ACTIVITY_POOL  = 30;
const MAX_NURSERY_PICKS  = 4;
const MAX_HOME_PICKS     = 3;
const MAX_WHY_LEN        = 180;

// EYFS area labels → the keys the card library and the activity bank use.
// Deliberately tolerant: obs data has mixed casing and three spellings of PSED.
function areaKey(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('personal') || s.includes('psed') || s.includes('emotional')) return 'psed';
  if (s.includes('communication') || s.includes('language')) return 'cl';
  if (s.includes('physical')) return 'pd';
  if (s.includes('litera')) return 'lit';
  if (s.includes('math') || s.includes('number')) return 'maths';
  if (s.includes('understanding') || s.includes('world')) return 'utw';
  if (s.includes('expressive') || s.includes('art')) return 'ead';
  return null;
}

/** Age bands a child of this many months plausibly sits in, as the libraries label them. */
function bandsForAgeMonths(months) {
  const m = Number(months);
  if (!Number.isFinite(m)) return [];
  if (m < 24) return ['0-2', 'baby', 'birth-2', '0-3'];
  if (m < 36) return ['2-3', 'toddler', '0-3', '2-5'];
  return ['3-5', 'preschool', 'pre-school', '2-5'];
}

/**
 * Score and cut the card index down to the cards that could plausibly help THIS
 * child. Ranked, not filtered to nothing: a child whose areas match no card at
 * all still gets a pool, because an empty pool means the model has nothing to
 * choose from and invents.
 */
function buildCardPool(cardIndex, { areas = [], ageMonths = null, limit = MAX_CARD_POOL } = {}) {
  const want = new Set(areas.map(areaKey).filter(Boolean));
  const bands = bandsForAgeMonths(ageMonths);
  const scored = (cardIndex || []).map(c => {
    let score = 0;
    const cardAreas = (c.areas || []).map(areaKey).filter(Boolean);
    for (const a of cardAreas) if (want.has(a)) score += 3;
    const ageText = [c.age_range, ...(c.age_bands || [])].join(' ').toLowerCase();
    if (bands.some(b => ageText.includes(b))) score += 2;
    if (!ageText) score += 1;                       // ageless cards suit anyone
    if (c.source === 'setting') score += 1;         // the setting's own first
    return { c, score };
  });
  scored.sort((x, y) => y.score - x.score || String(x.c.title).localeCompare(String(y.c.title)));
  return scored.slice(0, limit).map(({ c }) => ({
    slug: c.slug,
    title: c.title,
    strapline: String(c.strapline || '').slice(0, 140),
    areas: c.areas || [],
    age_range: c.age_range || null,
  }));
}

/**
 * The same for the Activity Bank. `rows` are ladn.planning_activities rows.
 * `home` mode keeps only what a family can actually do: no "whole-class", and
 * nothing whose materials read like a nursery stock cupboard.
 */
const SHOP_WORDS = /\b(laminat|printer|printable|print out|guillotine|light box|light table|tuff tray|tuff spot|projector|interactive whiteboard|class set|bulk)\b/i;

function buildActivityPool(rows, { areas = [], ageMonths = null, home = false, limit = MAX_ACTIVITY_POOL } = {}) {
  const want = new Set(areas.map(areaKey).filter(Boolean));
  const bands = bandsForAgeMonths(ageMonths);
  const out = [];
  for (const r of rows || []) {
    const materials = (r.materials_needed || []).join(' ');
    if (home) {
      if (String(r.group_size || '') === 'whole-class') continue;
      if (SHOP_WORDS.test(`${materials} ${r.setup_instructions || ''} ${r.description || ''}`)) continue;
    }
    let score = 0;
    const rowAreas = (r.eyfs_areas || []).map(areaKey).filter(Boolean);
    for (const a of rowAreas) if (want.has(a)) score += 3;
    const ageText = [r.age_group, ...(r.age_band || [])].join(' ').toLowerCase();
    if (bands.some(b => ageText.includes(b))) score += 2;
    if (!ageText) score += 1;
    if (Number(r.times_used) > 0) score += 1;       // things this setting actually does
    out.push({ r, score });
  }
  out.sort((x, y) => y.score - x.score || Number(x.r.id) - Number(y.r.id));
  return out.slice(0, limit).map(({ r }) => ({
    id: Number(r.id),
    title: r.title,
    description: String(r.description || '').slice(0, 160),
    areas: r.eyfs_areas || [],
    age_group: r.age_group || null,
    minutes: r.duration_minutes || null,
    materials: (r.materials_needed || []).slice(0, 6),
  }));
}

/**
 * The prompt fragment listing the pool. Nothing child-identifying is in here —
 * it is a library catalogue — but it is built by the same call that builds the
 * redacted evidence so the two cannot drift apart in which child they are about.
 */
function poolBlock({ nurseryCards, nurseryActivities, homeCards, homeActivities }) {
  const cardLine = c => `  card:${c.slug} — ${c.title}${c.strapline ? ` (${c.strapline})` : ''}`;
  const actLine  = a => `  activity:${a.id} — ${a.title}${a.minutes ? ` (${a.minutes} min)` : ''}${a.description ? ` — ${a.description}` : ''}`;
  const lines = [];
  lines.push('THINGS AVAILABLE AT NURSERY (choose only from these — nothing else exists):');
  lines.push(...(nurseryCards || []).map(cardLine));
  lines.push(...(nurseryActivities || []).map(actLine));
  lines.push('');
  lines.push('THINGS A FAMILY COULD DO AT HOME (choose only from these):');
  lines.push(...(homeCards || []).map(cardLine));
  lines.push(...(homeActivities || []).map(actLine));
  return lines.join('\n');
}

/** The instruction half. Kept next to poolBlock so the two describe one format. */
function instructionBlock() {
  return [
    'Then choose what would actually help.',
    `Choose UP TO ${MAX_NURSERY_PICKS} things to do at nursery and UP TO ${MAX_HOME_PICKS} for the family to try at home.`,
    'Use the EXACT identifiers printed above ("card:some-slug", "activity:123"). Never invent one.',
    'Fewer good choices beat a full list. If nothing in the pool fits, return an empty array.',
    'Reply with JSON and nothing else, in exactly this shape:',
    '{"nursery":[{"ref":"card:messy-play","why":"one short sentence"}],',
    ' "home":[{"ref":"activity:42","why":"one short sentence"}]}',
    'Each "why" is ONE plain sentence a parent would understand. No jargon, no citations, no brackets.',
  ].join('\n');
}

/** Pull the first JSON object out of a model reply that may be wrapped in prose. */
function parseSuggestionJson(text) {
  const s = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in the reply');
  return JSON.parse(m[0]);
}

function cleanWhy(v) {
  return String(v == null ? '' : v)
    .replace(/\[[^\]\n]{0,60}\]/g, '')      // the model reaches for b246's citation format
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_WHY_LEN);
}

/**
 * Validate one side's picks against the pool that was actually offered.
 *
 * @returns {{picks:Array, dropped:Array}}
 */
function validateSide(raw, { cardBySlug, activityById, cardPool, activityPool, max, side }) {
  const okCards = new Set((cardPool || []).map(c => c.slug));
  const okActs  = new Set((activityPool || []).map(a => Number(a.id)));
  const picks = [], dropped = [], seen = new Set();

  for (const item of Array.isArray(raw) ? raw : []) {
    if (picks.length >= max) {
      dropped.push({ side, ref: String(item && item.ref || ''), reason: `more than ${max} suggestions` });
      continue;
    }
    const ref = String(item && item.ref || '').trim();
    const m = ref.match(/^(card|activity):(.+)$/i);
    if (!m) { dropped.push({ side, ref, reason: 'not a card: or activity: reference' }); continue; }
    const kind = m[1].toLowerCase();
    const key = m[2].trim();

    if (kind === 'card') {
      if (!okCards.has(key)) {
        dropped.push({ side, ref, reason: cardBySlug && cardBySlug[key]
          ? 'a real card, but not one offered for this child'
          : 'no card with that slug exists' });
        continue;
      }
      if (seen.has(ref)) { dropped.push({ side, ref, reason: 'suggested twice' }); continue; }
      seen.add(ref);
      const card = (cardBySlug && cardBySlug[key]) || {};
      picks.push({
        kind: 'card', slug: key,
        title: card.title || key,
        strapline: String(card.strapline || '').slice(0, 140) || null,
        href: `/ey/activities-resources?tab=cards&card=${encodeURIComponent(key)}`,
        why: cleanWhy(item && item.why),
      });
      continue;
    }

    const id = parseInt(key, 10);
    if (!Number.isInteger(id) || !okActs.has(id)) {
      dropped.push({ side, ref, reason: activityById && activityById.has(id)
        ? 'a real activity, but not one offered for this child'
        : 'no activity with that id exists' });
      continue;
    }
    if (seen.has(`activity:${id}`)) { dropped.push({ side, ref, reason: 'suggested twice' }); continue; }
    seen.add(`activity:${id}`);
    const act = (activityById && activityById.get(id)) || {};
    picks.push({
      kind: 'activity', id,
      title: act.title || `Activity #${id}`,
      strapline: String(act.description || '').slice(0, 140) || null,
      href: `/ey/activities-resources?tab=activities&id=${id}`,
      why: cleanWhy(item && item.why),
    });
  }
  return { picks, dropped };
}

/**
 * The whole validation, both sides.
 * @returns {{nursery:Array, home:Array, dropped:Array, card_slugs:string[], activity_ids:number[],
 *            home_card_slugs:string[], home_activity_ids:number[]}}
 */
function validate(parsed, ctx) {
  const n = validateSide(parsed && parsed.nursery, Object.assign({}, ctx, {
    cardPool: ctx.nurseryCards, activityPool: ctx.nurseryActivities,
    max: MAX_NURSERY_PICKS, side: 'nursery',
  }));
  const h = validateSide(parsed && parsed.home, Object.assign({}, ctx, {
    cardPool: ctx.homeCards, activityPool: ctx.homeActivities,
    max: MAX_HOME_PICKS, side: 'home',
  }));
  const slugs = l => l.filter(p => p.kind === 'card').map(p => p.slug);
  const ids   = l => l.filter(p => p.kind === 'activity').map(p => p.id);
  return {
    nursery: n.picks, home: h.picks,
    dropped: [...n.dropped, ...h.dropped],
    card_slugs: slugs(n.picks), activity_ids: ids(n.picks),
    home_card_slugs: slugs(h.picks), home_activity_ids: ids(h.picks),
  };
}

/** An empty, well-formed result — what a failed or unasked model produces. */
function empty(reason) {
  return {
    nursery: [], home: [], dropped: [],
    card_slugs: [], activity_ids: [], home_card_slugs: [], home_activity_ids: [],
    unavailable: reason || null,
  };
}

/** The lines b246's `at_home` section gains when there are home suggestions. */
function homeSectionAddendum(result) {
  if (!result || !result.home || !result.home.length) return '';
  const lines = ['', 'Things we use here that you could try too:'];
  for (const p of result.home) {
    lines.push(`• ${p.title}${p.why ? ` — ${p.why}` : ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  MAX_CARD_POOL, MAX_ACTIVITY_POOL, MAX_NURSERY_PICKS, MAX_HOME_PICKS,
  areaKey, bandsForAgeMonths,
  buildCardPool, buildActivityPool, poolBlock, instructionBlock,
  parseSuggestionJson, validate, validateSide, empty, homeSectionAddendum,
};
