'use strict';
/**
 * child-suggestions.js — resources-20261030
 *
 * "Resources are too overwhelming, they should be smart filtered / suggested based on
 *  next steps and interests etc." — pre-school staff, via Toby, 30 Oct 2026.
 *
 * A short, ranked list for ONE child out of the two stores staff already browse in full
 * (resource cards, the Activity Bank). No model, no new store: it scores what exists,
 * and every pick says why it was picked, so a practitioner can see the reason and
 * ignore it.
 *
 * Signals, strongest first — the same area/age keys termly-suggestions.js uses:
 *   next step   the area(s) of the observation each open next step came from   +4 per area
 *   interest    a word from All About Me (interests, favourite toys/activities) +3 per word, max 2
 *   theme       a word from the room's plan this week (theme + day titles)      +2 per word, max 2
 *   age         the card/activity's age band fits the child                     +2
 * Words are matched whole-word against the card's search text / the activity's title,
 * description and tags. Pure: handed rows, returns picks. Planning/resource text only.
 */
const SUG = require('./termly-suggestions');

const STOP = new Set(('a an and are as at be but by for from has have he her his i in is it its of on or our she '
  + 'so that the their them they this to was we were with you your will what when where which who why how '
  + 'like likes loves love enjoys enjoy playing play plays toys toy activities activity really very also lots '
  + 'about around different other things using make makes made making explore exploring create creating circle talk week weeks day days time our own').split(' '));

/** Distinctive words (4+ letters, not stop words), de-duplicated, in order. */
function words(text, max = 12) {
  const out = [];
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) {
    const k = w.replace(/'s$/, '').replace(/s$/, '');
    if (k.length < 4 || STOP.has(w) || STOP.has(k) || out.includes(k)) continue;
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

function hits(hay, list, cap) {
  const found = [];
  for (const w of list) {
    if (new RegExp('\\b' + w.replace(/[^a-z'-]/g, '') + '(s|es|ing)?\\b').test(hay)) found.push(w);
    if (found.length >= cap) break;
  }
  return found;
}

const AREA_LABEL = { psed: 'PSED', cl: 'Communication & Language', pd: 'Physical', lit: 'Literacy',
  maths: 'Maths', utw: 'Understanding the World', ead: 'Expressive Arts' };

function score(item, { stepAreas, ageBands, interestWords, themeWords }) {
  const why = [];
  let s = 0;
  const areas = (item.areas || []).map(SUG.areaKey).filter(Boolean);
  const matched = [...new Set(areas.filter(a => stepAreas.has(a)))];
  if (matched.length) { s += 4 * matched.length; why.push('Next step: ' + matched.map(a => AREA_LABEL[a]).join(', ')); }
  const iw = hits(item.hay, interestWords, 2);
  if (iw.length) { s += 3 * iw.length; why.push('Interest: ' + iw.join(', ')); }
  const tw = hits(item.hay, themeWords, 2);
  if (tw.length) { s += 2 * tw.length; why.push('This week: ' + tw.join(', ')); }
  if (ageBands.length && ageBands.some(b => item.age.includes(b))) s += 2;
  else if (!item.age) s += 1;
  return { s, why };
}

/**
 * @param {object} o
 *   cardIndex      resource-cards _loadCards().index
 *   activityRows   ladn.planning_activities rows (title, description, tags, eyfs_areas, age_group, age_band)
 *   stepAreas      area labels from the child's open next steps
 *   ageMonths      the child's age in months
 *   interestText   All About Me interests + favourite toys/activities
 *   themeText      the room plan's theme + this week's day titles
 *   limit          picks per list (default 6)
 */
function suggestForChild(o) {
  const ctx = {
    stepAreas: new Set((o.stepAreas || []).map(SUG.areaKey).filter(Boolean)),
    ageBands: SUG.bandsForAgeMonths(o.ageMonths),
    interestWords: words(o.interestText, 10),
    themeWords: words(o.themeText, 14),
  };
  const limit = o.limit || 6;
  const rank = (items) => items
    .map(it => ({ it, ...score(it, ctx) }))
    .filter(x => x.why.length)                       // only things with a reason to be here
    .sort((a, b) => b.s - a.s || String(a.it.title).localeCompare(String(b.it.title)))
    // the Activity Bank holds many near-copies ("Autumn leaves mark making", "… quest",
    // "… fun"): one per opening three words, or the short list is the same idea six times
    .filter(function (x) {
      const k = String(x.it.title || '').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).slice(0, 3).join(' ');
      if (this.has(k)) return false; this.add(k); return true;
    }, new Set())
    .slice(0, limit);

  const cards = rank((o.cardIndex || []).map(c => ({
    ref: c, title: c.title, areas: c.areas || [],
    age: [c.age_range, ...(c.age_bands || [])].join(' ').toLowerCase(),
    hay: String(c.search || [c.title, c.strapline, (c.themes || []).join(' ')].join(' ')).toLowerCase(),
  }))).map(x => ({ slug: x.it.ref.slug, title: x.it.ref.title, strapline: String(x.it.ref.strapline || '').slice(0, 140),
                   areas: x.it.ref.areas || [], why: x.why }));

  const activities = rank((o.activityRows || []).map(r => ({
    ref: r, title: r.title, areas: r.eyfs_areas || [],
    age: [r.age_group, ...(r.age_band || [])].join(' ').toLowerCase(),
    hay: [r.title, r.description, (r.tags || []).join(' ')].join(' ').toLowerCase(),
  }))).map(x => ({ id: Number(x.it.ref.id), title: x.it.ref.title,
                   description: String(x.it.ref.description || '').slice(0, 160),
                   areas: x.it.ref.eyfs_areas || [], why: x.why }));

  return {
    cards, activities,
    signals: {
      next_step_areas: [...ctx.stepAreas].map(a => AREA_LABEL[a]),
      interest_words: ctx.interestWords,
      theme_words: ctx.themeWords,
    },
  };
}

module.exports = { suggestForChild, words };
