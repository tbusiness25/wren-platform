'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// b287 — PUBLIC CURRICULUM + PRINTABLE HOME CARDS. UNAUTHENTICATED.
//
// The parent-facing read side of the planning work. example-nursery.co.uk
// reaches this through the same-origin /api/public/ nginx proxy that already
// serves the availability heat-map, the careers list and the T&Cs.
//
//   GET /api/public/curriculum          → both rooms, six half-terms each:
//                                         theme, key books, songs, learning
//                                         intentions, activities.
//   GET /api/public/cards               → index of home-suitable cards.
//   GET /api/public/cards/:slug         → one card, parent-facing fields only.
//
// ── THE ONE RULE THAT MATTERS ──────────────────────────────────────────────
// Everything this router returns is built by hand, key by key, from PUBLIC_KEYS
// below. Nothing is ever spread from a database row or a card file into a
// response. That is deliberate and it is the whole security model:
//
//   * term_plans also holds evaluation, carry_forward, created_by, eyfs_grid;
//   * termly_plan_days holds staff_note and role_of_adult;
//   * termly_plan_weeks.notes holds internal planning chatter
//     ("Pre-filled from the setting's yearly plan — a starting point");
//   * curriculum_activities holds eyfs_areas (EYFS codes);
//   * every resource card holds impact[].fledge (framework codes),
//     source_note (import provenance) and coel (practitioner jargon).
//
// None of that is parent-facing, and none of it can leak by accident: a column
// or a card key added tomorrow is invisible here until someone adds it to
// PUBLIC_KEYS on purpose. scripts/b287-verify.js asserts, over every response
// this router can produce, that the key set is exactly the allowlist.
//
// ── b290: THE SECOND RULE ──────────────────────────────────────────────────
// The allowlist decides WHICH FIELDS may be published. term_plans.status decides
// WHETHER A PLAN MAY BE PUBLISHED AT ALL. A half-term the room team is still
// drafting appears here as its name and its dates and the sentence "still being
// planned" — never its theme, books, songs, intentions or activities. See
// src/lib/plan-status.js, and scripts/b290-verify.js asserts it over the live
// response.
//
// Mounted in editions/ladn/server-unified.js next to the other /api/public/
// routers, BEFORE the auth and off-site gates. Portal-agnostic (matches on
// path, any host).
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const planStatus = require('../lib/plan-status');   // b290 — drafts never come out here
const TPV = require('../lib/term-plan-view');   // b302 — one reader for a term_plans row
const router = express.Router();

const CARDS_DIR = path.join(__dirname, '../content/resource-cards');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── the allowlist ──────────────────────────────────────────────────────────
// Read this as the contract with the public website. If a key is not in here it
// does not leave the building.
const PUBLIC_KEYS = {
  curriculum:  ['generated', 'academic_year', 'rooms'],
  room:        ['room', 'ages', 'terms'],
  term:        ['term', 'starts', 'ends', 'planned', 'theme', 'books', 'songs',
                'intentions', 'activities', 'note'],
  activity:    ['title', 'area', 'description', 'card'],
  card_index:  ['generated', 'count', 'areas', 'age_bands', 'categories', 'cards'],
  card_stub:   ['slug', 'title', 'strapline', 'kind', 'category', 'ages',
                'age_bands', 'areas'],
  card_full:   ['slug', 'title', 'strapline', 'kind', 'category', 'ages',
                'age_bands', 'areas', 'book_author', 'why', 'how', 'talk_about',
                'you_will_need', 'look_for'],
};

// Build an object with exactly the allowed keys, dropping empties. Every
// response body in this file goes through here.
function pick(kind, src) {
  const allowed = PUBLIC_KEYS[kind];
  if (!allowed) throw new Error('unknown public shape: ' + kind);
  const out = {};
  for (const k of allowed) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

// ── small helpers ──────────────────────────────────────────────────────────
const clean = v => (typeof v === 'string' ? v.trim() : '');

// 60 of the pre-school library activities were imported from the yearly planning
// PDF with its filing label still on the front of the description:
//   "Art & Design · Autumn 1 weeks 3-4 — Provide mirrors so children can…"
// That prefix is where the line sat in the staff plan. A parent does not need
// it and it is exactly the kind of internal shorthand this page is meant not to
// have, so strip it. Anything that does not match is returned untouched.
const PLAN_PREFIX = /^[^—]{1,60}·[^—]{1,45}—\s*/;
const parentText = v => clean(v).replace(PLAN_PREFIX, '');
// The planning text is written TO the room team, in the imperative: "Provide
// card, paint and star-shaped cookie cutters. Encourage the children to dip the
// star…". On a card a parent is holding, the imperative is correct — they are
// the one doing it. On the curriculum page it is not: the page is describing
// what the nursery does, and an instruction addressed to somebody else is
// exactly the "written for practitioners" register the brief asks us out of.
//
// So on that page only, put the sentences in the setting's voice. Deliberately a
// short, closed list of leading verbs applied at sentence starts — not a
// rephrasing engine. Anything not on the list is left exactly as the room team
// wrote it.
const STAFF_VERBS = ['Provide', 'Encourage', 'Set up', 'Sing', 'Read', 'Make', 'Allow',
  'Collect', 'Let', 'Show', 'Fill', 'Add', 'Give', 'Help', 'Talk', 'Model', 'Offer',
  'Ask', 'Invite', 'Support', 'Play', 'Use', 'Place', 'Hide', 'Cut', 'Draw', 'Paint'];
const STAFF_VERB_RE = new RegExp(
  '(^|[.!?]\\s+)(' + STAFF_VERBS.join('|') + ')\\b', 'g');
function parentVoice(v) {
  const s = parentText(v);
  if (!s) return '';
  return s.replace(STAFF_VERB_RE, (m, lead, verb) => lead + 'We ' + verb.toLowerCase());
}

// Trim to a word boundary — a strapline cut mid-word reads like a bug.
function summarise(v, max) {
  const s = parentText(v);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd() + '…';
}
const strArray = v => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);
// pg returns DATE as a local-midnight JS Date; String()/toISOString() both lie.
// Use the local getters. (See reference: pg DATE → ymd trap.)
function ymd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Practitioner category slugs → words a parent reads without translating.
// Anything unmapped falls back to a de-slugged Title Case, never the raw code.
const CATEGORY_LABEL = {
  sensory: 'Sensory play', malleable_sensory: 'Sensory play',
  art: 'Art & making', art_design: 'Art & making', creative: 'Art & making',
  maths: 'Numbers & shapes', maths_physical: 'Numbers & moving',
  maths_provocations: 'Numbers & shapes', literacy_maths: 'Stories & numbers',
  literacy: 'Stories & books', book_focus: 'Stories & books',
  literacy_markmaking: 'Mark making & writing',
  role_play: 'Pretend play', small_world: 'Small world play',
  construction: 'Building & construction', loose_parts: 'Loose parts',
  music_sound: 'Music & sound', physical: 'Moving & climbing',
  physical_outdoor: 'Outdoors & active', outdoor_forest_school: 'Outdoors & nature',
  nature_seasons: 'Nature & seasons', science_exploration: 'Exploring & finding out',
  understanding_world: 'The world around us', community_people: 'People & community',
  festivals_celebrations: 'Festivals & celebrations', food_cooking: 'Cooking & food',
  wellbeing_regulation: 'Feelings & calm', self_care: 'Looking after myself',
  schemas: 'Play patterns', baby_room: 'Babies', toddler_play: 'Toddlers',
  transport_journeys: 'Transport & journeys', inclusive_send: 'Inclusive play',
};
function categoryLabel(slug) {
  const s = clean(slug);
  if (!s) return null;
  if (CATEGORY_LABEL[s]) return CATEGORY_LABEL[s];
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Age ranges written for parents rather than as a code. The two libraries do not
// agree on a format: resource cards use '6m-2' / '2-5', curriculum_activities
// mixes those with the band words 'baby' / 'toddler' / 'pre-school'. Both shapes
// resolve to the same handful of parent-readable labels.
const AGE_PRETTY = {
  '6m-2': '6 months – 2 years', '0-2': 'Under 2s', '0-3': 'Under 3s',
  '1-3': '1 – 3 years', '1-4': '1 – 4 years', '1-5': '1 – 5 years',
  '2-3': '2 – 3 years', '2-4': '2 – 4 years', '2-5': '2 – 5 years',
  '3-5': '3 – 5 years', '0-5': 'All ages',
  'baby': 'Babies (under 2)', 'toddler': 'Toddlers (2 – 3)',
  'pre-school': 'Pre-school (3 – 5)', 'preschool': 'Pre-school (3 – 5)',
};
function agesLabel(range) {
  const r = clean(range).toLowerCase();
  if (!r || r === 'all') return null;
  return AGE_PRETTY[r] || clean(range);
}

// ── DEFAULT_HOME_SUITABLE ──────────────────────────────────────────────────
// Applied only where nobody has decided (public_card_flags has no row /
// curriculum_activities.home_suitable IS NULL). A stored flag always wins.
//
// Cards: publish by default, and exclude only the ones that are ABOUT how the
// setting organises itself around a child rather than about play — a key-person
// display, a settling-in plan. Those need a conversation with the key person,
// not a print button.
//
// The test runs on the TITLE AND STRAPLINE only — what the card is — and not on
// the body. An earlier draft of this build matched the body too and threw out 24
// cards, among them treasure baskets, tummy time, peekaboo, the book corner and
// a now-and-next board, purely because the method text says the word
// "practitioner" somewhere. Those are some of the best things a parent can do at
// home, and a visual timetable or a now-and-next board is mainstream advice TO
// parents. A rule that quietly withholds them is worse than no rule. So the
// backstop is deliberately narrow (it catches 2 of 327 today) and the real list
// of exclusions lives in public_card_flags, where a manager can see it and
// change it.
const SETTING_ONLY = /one-page profile|settling[- ]in|back to nursery|safeguard|risk assessment|key[- ]person|key[- ]worker|\bstaff\b|\bpractitioner|every adult|\bSENCo\b|\bEHCP\b/i;

function defaultCardSuitable(card) {
  return !SETTING_ONLY.test([clean(card.title), clean(card.strapline)].join(' '));
}
function defaultActivitySuitable(row) {
  return clean(row.parent_tip) !== '';
}

// ── card loading (file-backed; mirrors src/routes/resource-cards.js) ───────
let _cards = { at: 0, bySlug: null };
function loadCards() {
  const now = Date.now();
  if (_cards.bySlug && (now - _cards.at) < CACHE_TTL_MS) return _cards.bySlug;
  const bySlug = Object.create(null);
  let names = [];
  try { names = fs.readdirSync(CARDS_DIR).filter(f => f.endsWith('.json')).sort(); }
  catch { names = []; }
  for (const name of names) {
    let card;
    try { card = JSON.parse(fs.readFileSync(path.join(CARDS_DIR, name), 'utf8')); }
    catch { continue; }                      // never 500 the index over one bad file
    if (!card || typeof card !== 'object') continue;
    const slug = clean(card.slug) || name.replace(/\.json$/, '');
    if (!SLUG_RE.test(slug)) continue;
    bySlug[slug] = card;
  }
  _cards = { at: now, bySlug };
  return bySlug;
}

// A resource card, projected for parents. Note what is NOT here: impact[].fledge
// (framework codes), coel, aspects, themes, source, source_note, half_term.
function projectCard(slug, card, full) {
  const base = {
    slug,
    title: clean(card.title) || slug,
    strapline: clean(card.strapline),
    kind: 'card',
    category: categoryLabel(card.category),
    ages: agesLabel(card.age_range),
    // 25 of the shipped cards (the book cards, and the b245 planning imports)
    // predate age_bands and carry only age_range. Derive the bands for those,
    // or the age filter on the page hides them without telling anyone.
    age_bands: strArray(card.age_bands).length
      ? strArray(card.age_bands) : bandsFromRange(card.age_range),
    areas: strArray(card.areas),
  };
  if (!full) return pick('card_stub', base);
  return pick('card_full', {
    ...base,
    book_author: clean(card.author),
    why: strArray(card.intent),
    how: strArray(card.implementation),
    talk_about: strArray(card.key_questions),
    you_will_need: strArray(card.enhancements),
    // impact entries are {text, fledge:[codes]} — take the sentence, drop the codes.
    look_for: Array.isArray(card.impact)
      ? card.impact.map(i => clean(typeof i === 'string' ? i : i && i.text)).filter(Boolean)
      : [],
  });
}

// A curriculum_activities row, projected for parents. eyfs_areas never appears.
function projectActivity(row, full) {
  const base = {
    slug: 'activity-' + row.id,
    title: clean(row.name),
    strapline: summarise(row.description, 180),
    kind: 'activity',
    category: categoryLabel(row.category),
    ages: agesLabel(row.age_range),
    age_bands: bandsFromRange(row.age_range),
    areas: [],
  };
  if (!full) return pick('card_stub', base);
  return pick('card_full', {
    ...base,
    // An activity has one piece of text, and on the index it is the strapline.
    // On the opened/printed card it becomes "How to do it" in full, so showing
    // the truncated copy above it as well just prints the same sentence twice.
    strapline: '',
    how: [parentText(row.description)].filter(Boolean),
    you_will_need: [clean(row.resources_needed)].filter(Boolean),
    talk_about: [],
    why: [clean(row.parent_tip)].filter(Boolean),
    look_for: [],
  });
}

// Activities carry age_range but not age_bands; derive the bands so the one age
// filter on the page works across both kinds. Handles both shapes the column
// actually holds: a numeric range ('6m-2', '2-5') and a band word ('toddler').
function bandsFromRange(range) {
  const r = clean(range).toLowerCase();
  if (!r) return [];
  if (r === 'all') return ['baby', 'toddler', 'preschool'];
  if (r === 'baby') return ['baby'];
  if (r === 'toddler') return ['toddler'];
  if (r === 'pre-school' || r === 'preschool') return ['preschool'];
  const m = r.match(/^(\d+)m?-(\d+)$/);
  if (!m) return [];
  const lo = /^6m-/.test(r) ? 0 : Number(m[1]);
  const hi = Number(m[2]);
  const out = [];
  if (lo <= 1) out.push('baby');
  if (lo <= 3 && hi >= 2) out.push('toddler');
  if (hi >= 3) out.push('preschool');
  return out;
}

// ── settings ───────────────────────────────────────────────────────────────
async function enabled(db) {
  try {
    const { rows } = await db.query(
      `SELECT value FROM settings WHERE key = 'public_curriculum_enabled'`);
    if (!rows.length) return true;                       // absent = on
    return !/^(false|0|off|no)$/i.test(clean(rows[0].value));
  } catch { return true; }
}

// Read-only GETs behind Cloudflare, and every response carries a 10-minute
// Cache-Control, so the origin sees a small fraction of real traffic. The limit
// is here to stop someone scraping the card library in a loop, not to ration a
// family: a parent opening thirty cards in an evening must never see a 429.
// (trust proxy 1 is set in server-unified.js, so this keys on the visitor.)
const publicLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 600,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// ── GET /api/public/curriculum ─────────────────────────────────────────────
router.get('/api/public/curriculum', publicLimiter, async (req, res) => {
  const db = require('../db/pool').getPool();
  try {
    if (!await enabled(db)) return res.status(404).json({ error: 'not_published' });

    // Which academic year? The one the caller asked for, else the year the
    // school_terms calendar says today sits in, else the latest planned year.
    const asked = (String(req.query.year || '').match(/^\d{4}-\d{4}$/) || [])[0];
    const year = asked || await currentYear(db);
    if (!year) return res.json(pick('curriculum', { generated: ymd(new Date()), rooms: [] }));

    const { rows: terms } = await db.query(
      `SELECT id, term, half, name, start_date, end_date
         FROM school_terms WHERE academic_year = $1 ORDER BY start_date`, [year]);
    const termByName = new Map(terms.map(t => [t.name, t]));
    const termOrder = new Map(terms.map((t, i) => [t.name, i]));

    const { rows: rooms } = await db.query(
      `SELECT id, name, min_age_months, max_age_months FROM rooms ORDER BY id`);

    // b290 — DRAFTS DO NOT COME OUT HERE. On a schema that has the b290 column
    // the row's real status is read; on one that does not (the demo editions,
    // wren-ht, anything un-migrated) the expression yields 'published', which is
    // precisely how those schemas behaved before b290 existed.
    const statusCol = await planStatus.hasStatusColumn(db)
      ? 'status' : `'published'::text AS status`;
    const { rows: plans } = await db.query(
      `SELECT id, room_id, term_name, theme, key_books, songs, learning_intentions,
              intentions, plan_source, school_term_id, ${statusCol}
         FROM term_plans WHERE academic_year = $1`, [year]);
    if (!plans.length) {
      return res.json(pick('curriculum', {
        generated: ymd(new Date()), academic_year: year, rooms: [] }));
    }

    // A draft half-term is still LISTED — dropping it would leave a year with
    // holes in it, which reads as a broken page rather than as work in progress —
    // but it contributes nothing except the "still being planned" note below.
    // Its weeks, days and activities are never even fetched.
    const planIds = plans.filter(planStatus.isPublishedRow).map(p => p.id);
    if (!planIds.length) planIds.push(-1);       // ANY($1) needs a non-empty array

    // Baby room plans carry a day-by-day grid; pre-school plans carry weeks that
    // point at curriculum_activities. Read both, publish the union.
    // NOTE the column list: staff_note and role_of_adult are internal and are
    // not selected, so they cannot reach the projection even by mistake. The
    // day's activity_ids give the same activity a parent-readable description
    // through curriculum_activities, which is where it belongs.
    const { rows: days } = await db.query(
      `SELECT plan_id, category, category_slug, title, activity_ids
         FROM termly_plan_days
         WHERE plan_id = ANY($1) AND COALESCE(title,'') <> ''
         ORDER BY plan_id, week_no, weekday`, [planIds]);
    const { rows: weeks } = await db.query(
      `SELECT plan_id, activity_ids, resource_card_ids FROM termly_plan_weeks
         WHERE plan_id = ANY($1) ORDER BY plan_id, week_no`, [planIds]);

    const wantedActivityIds = new Set();
    for (const w of weeks) {
      for (const id of asIntArray(w.activity_ids)) wantedActivityIds.add(id);
    }
    for (const d of days) {
      for (const id of asIntArray(d.activity_ids)) wantedActivityIds.add(id);
    }
    let actById = new Map();
    if (wantedActivityIds.size) {
      const { rows: acts } = await db.query(
        `SELECT id, name, description, category FROM curriculum_activities
           WHERE id = ANY($1)`, [[...wantedActivityIds]]);
      actById = new Map(acts.map(a => [a.id, a]));
    }

    const cards = loadCards();
    const daysByPlan = groupBy(days, d => d.plan_id);
    const weeksByPlan = groupBy(weeks, w => w.plan_id);

    const out = rooms.map(room => {
      const roomPlans = plans
        .filter(p => p.room_id === room.id)
        .sort((a, b) => (termOrder.has(a.term_name) ? termOrder.get(a.term_name) : 99)
                      - (termOrder.has(b.term_name) ? termOrder.get(b.term_name) : 99));
      const termsOut = roomPlans.map(p => {
        const st = termByName.get(p.term_name);
        const theme = clean(p.theme);
        // A plan with no theme is a term nobody has written yet. Say so —
        // do not invent it and do not quietly drop the half-term.
        // b290 — a DRAFT is the same case from a parent's side: the room team is
        // still working on it, so it is named and dated and nothing else. Note
        // what is NOT in the branch below: no theme, no books, no songs, no
        // intentions, no activities. A draft cannot leak through it.
        const notPlanned = !theme
          || /^not-planned/i.test(clean(p.plan_source))
          || !planStatus.isPublishedRow(p);
        if (notPlanned) {
          return pick('term', {
            term: p.term_name,
            starts: st ? ymd(st.start_date) : null,
            ends: st ? ymd(st.end_date) : null,
            planned: false,
            note: 'Still being planned. We publish each half-term once the room team '
                + 'has finished it, so this one will appear here nearer the time.',
          });
        }
        return pick('term', {
          term: p.term_name,
          starts: st ? ymd(st.start_date) : null,
          ends: st ? ymd(st.end_date) : null,
          planned: true,
          theme,
          books: strArray(p.key_books),
          songs: strArray(p.songs),
          // b302 — through the shared reader, so a plan whose intentions were
          // ticked as framework statements (jsonb) publishes here too. For every
          // row this page has ever served the result is identical: the flat
          // text[] still wins.
          intentions: TPV.intentionList(p),
          activities: activitiesFor(p, daysByPlan, weeksByPlan, actById, cards),
        });
      });
      return pick('room', {
        room: clean(room.name),
        ages: ageBandLabel(room.min_age_months, room.max_age_months),
        terms: termsOut,
      });
    }).filter(r => r.terms && r.terms.length);

    res.set('Cache-Control', 'public, max-age=600');
    res.json(pick('curriculum', {
      generated: ymd(new Date()), academic_year: year, rooms: out }));
  } catch (e) {
    console.error('[public-curriculum]', e.message);
    res.status(500).json({ error: 'Could not load the curriculum right now.' });
  }
});

// The activities a parent sees for one half-term: deduplicated by title, because
// the same activity repeats across the weeks of a half-term in the day grid.
function activitiesFor(plan, daysByPlan, weeksByPlan, actById, cards) {
  const seen = new Set();
  const out = [];
  const add = (title, area, description, cardSlug) => {
    const key = clean(title).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(pick('activity', {
      title: clean(title),
      area: categoryLabel(area),
      description: parentVoice(description),
      card: cardSlug && cards[cardSlug] ? cardSlug : null,
    }));
  };
  for (const d of (daysByPlan.get(plan.id) || [])) {
    // The day grid gives the title and the category; the description comes from
    // the linked curriculum_activities row, never from role_of_adult/staff_note
    // (which the query does not even select).
    const linked = asIntArray(d.activity_ids).map(id => actById.get(id)).find(Boolean);
    add(d.title, d.category_slug || d.category, linked && linked.description, null);
  }
  for (const w of (weeksByPlan.get(plan.id) || [])) {
    for (const id of asIntArray(w.activity_ids)) {
      const a = actById.get(id);
      if (a) add(a.name, a.category, a.description, null);
    }
    for (const slug of asStrArray(w.resource_card_ids)) {
      const c = cards[slug];
      if (c) add(c.title, c.category, c.strapline, slug);
    }
  }
  return out;
}

function ageBandLabel(minM, maxM) {
  const m = Number(minM), x = Number(maxM);
  if (!Number.isFinite(m) || !Number.isFinite(x)) return null;
  const part = n => (n < 24 ? `${n} months` : `${Math.round(n / 12)} years`);
  return `${part(m)} – ${part(x)}`;
}
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
function asIntArray(v) {
  const a = Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })();
  return a.map(n => parseInt(n, 10)).filter(Number.isInteger);
}
function asStrArray(v) {
  const a = Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })();
  return a.map(clean).filter(s => SLUG_RE.test(s));
}
async function currentYear(db) {
  const today = ymd(new Date());
  const { rows } = await db.query(
    `SELECT academic_year FROM school_terms
      WHERE start_date <= $1::date AND end_date >= $1::date LIMIT 1`, [today]);
  if (rows.length) return rows[0].academic_year;
  const { rows: nxt } = await db.query(
    `SELECT academic_year FROM school_terms WHERE end_date >= $1::date
      ORDER BY start_date LIMIT 1`, [today]);
  if (nxt.length) return nxt[0].academic_year;
  const { rows: any } = await db.query(
    `SELECT academic_year FROM term_plans WHERE academic_year IS NOT NULL
      ORDER BY academic_year DESC LIMIT 1`);
  return any.length ? any[0].academic_year : null;
}

// ── the printable home-card library ────────────────────────────────────────
// Both libraries, one list. Overrides come from the DB, defaults from the rule.
async function homeCards(db) {
  const cards = loadCards();
  let flags = new Map();
  try {
    const { rows } = await db.query(`SELECT slug, home_suitable FROM public_card_flags`);
    flags = new Map(rows.map(r => [r.slug, r.home_suitable]));
  } catch { /* table not migrated yet — fall back to the rule for every card */ }

  const out = [];
  for (const slug of Object.keys(cards)) {
    const flag = flags.has(slug) ? flags.get(slug) : null;
    const ok = flag === null ? defaultCardSuitable(cards[slug]) : flag === true;
    if (ok) out.push({ slug, card: cards[slug], kind: 'card' });
  }

  let acts = [];
  try {
    const { rows } = await db.query(
      `SELECT id, name, description, category, age_range, resources_needed,
              parent_tip, home_suitable
         FROM curriculum_activities
        WHERE is_library IS TRUE AND COALESCE(name,'') <> ''`);
    acts = rows.filter(r => (r.home_suitable === null || r.home_suitable === undefined)
      ? defaultActivitySuitable(r) : r.home_suitable === true);
  } catch (e) {
    // home_suitable column missing (pre-migration) — fall back to the rule.
    const { rows } = await db.query(
      `SELECT id, name, description, category, age_range, resources_needed, parent_tip
         FROM curriculum_activities
        WHERE is_library IS TRUE AND COALESCE(name,'') <> ''`);
    acts = rows.filter(defaultActivitySuitable);
  }
  for (const row of acts) out.push({ slug: 'activity-' + row.id, row, kind: 'activity' });
  return out;
}

router.get('/api/public/cards', publicLimiter, async (req, res) => {
  const db = require('../db/pool').getPool();
  try {
    if (!await enabled(db)) return res.status(404).json({ error: 'not_published' });
    const items = await homeCards(db);
    const stubs = items
      .map(it => it.kind === 'card' ? projectCard(it.slug, it.card, false)
                                    : projectActivity(it.row, false))
      .filter(s => s.title)
      .sort((a, b) => a.title.localeCompare(b.title));

    const areas = [...new Set(stubs.flatMap(s => s.areas || []))].sort();
    const bands = ['baby', 'toddler', 'preschool']
      .filter(b => stubs.some(s => (s.age_bands || []).includes(b)));
    const cats = [...new Set(stubs.map(s => s.category).filter(Boolean))].sort();

    res.set('Cache-Control', 'public, max-age=600');
    res.json(pick('card_index', {
      generated: ymd(new Date()), count: stubs.length,
      areas, age_bands: bands, categories: cats, cards: stubs }));
  } catch (e) {
    console.error('[public-cards]', e.message);
    res.status(500).json({ error: 'Could not load the activity cards right now.' });
  }
});

router.get('/api/public/cards/:slug', publicLimiter, async (req, res) => {
  const db = require('../db/pool').getPool();
  const slug = clean(req.params.slug);
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'bad slug' });
  try {
    if (!await enabled(db)) return res.status(404).json({ error: 'not_published' });
    // Resolve through homeCards() and never through the file/table directly, so
    // a card that is not published cannot be fetched by guessing its slug.
    const item = (await homeCards(db)).find(i => i.slug === slug);
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'public, max-age=600');
    res.json(item.kind === 'card' ? projectCard(item.slug, item.card, true)
                                  : projectActivity(item.row, true));
  } catch (e) {
    console.error('[public-cards/:slug]', e.message);
    res.status(500).json({ error: 'Could not load that card right now.' });
  }
});

module.exports = router;
// Exported for scripts/b287-verify.js. The allowlist assertion has to test the
// same objects and the same projection the router uses, not a copy of them that
// can drift — and it runs the projection in-process over EVERY card and every
// library activity, which is both more exhaustive than walking the HTTP endpoint
// and the only way to check a card the endpoint deliberately will not serve.
module.exports.PUBLIC_KEYS = PUBLIC_KEYS;
module.exports.defaultCardSuitable = defaultCardSuitable;
module.exports.defaultActivitySuitable = defaultActivitySuitable;
module.exports.categoryLabel = categoryLabel;
module.exports.projectCard = projectCard;
module.exports.projectActivity = projectActivity;
module.exports.loadCards = loadCards;
