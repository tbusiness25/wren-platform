'use strict';
/**
 * termly-update.js — b246 (2026-08-28)
 *
 * The five sections of a termly update: gathering the evidence, drafting from
 * it, and refusing to draft when there is not enough.
 *
 * ── THE FIVE SECTIONS, IN TOBY'S ORDER ──────────────────────────────────────
 *   1  went_well    What went well last term
 *   2  working_on   What we're working on this term
 *   3  next_steps   Next steps — each one able to carry resource cards and
 *                   activities the keyperson chooses
 *   4  at_home      Things you could try at home
 *   5  tracking     Where <name> is in their learning (the framework tracker,
 *                   included IN the update rather than on a separate screen)
 *
 * ── THIS IS NOT A SECOND REPORT ENGINE ──────────────────────────────────────
 * b93 wrote 63 drafts nobody ever finalised and its toggles were switched off on
 * 2026-08-28 for exactly that reason. So there is no nightly job in b246 and no
 * "draft everything that is due" button anywhere in it. A draft is produced only
 * when a practitioner opens a child's update, and it does not exist as a
 * document until they send it. The schedule chases a PERSON, not a queue of
 * machine output.
 *
 * ── THE FABRICATION RULE, INHERITED FROM b243 ───────────────────────────────
 * Same three mechanisms as src/lib/two-year-check.js, for the same reason:
 *
 *   1. A section with too little behind it is NEVER sent to the model. It gets a
 *      deterministic "not enough recorded yet" paragraph naming what is missing.
 *      A model that is not asked cannot invent.
 *   2. Every drafted section is handed a numbered evidence list (OBS-n, NS-n,
 *      PA-n, TRK-n, TU-n) and told to cite it. Citations are checked against the
 *      list that was actually supplied; anything else is stripped.
 *   3. The evidence index is stored on the report row, so the practitioner
 *      reviewing the draft can see the record behind every line.
 *
 * Sections 3 and 5 are never modelled at all. Next steps are a professional
 * commitment a keyperson makes, and the tracking data is a fact — both are
 * assembled from the records verbatim.
 *
 * ── THE VOICE OF SECTION 4 ──────────────────────────────────────────────────
 * Toby: "things parents can do at home (see examples on wren)". The examples are
 * there, and they agree with each other:
 *
 *   scripts/report-engine-nightly.js  "**Ideas for home** — 2-3 simple, concrete
 *                                     things parents can do at home to support
 *                                     the next steps"
 *   src/routes/study.js               the activity vouchers: a short title, a
 *                                     handful of things already in the kitchen,
 *                                     four or five numbered steps, and a line
 *                                     for the child to tell their key worker
 *   src/lib/two-year-check.js         "one or two simple things you could try at
 *                                     home"
 *
 * So: two or three ideas, each with a title, what you need (household things),
 * two to four steps, and a "tell us how it went" line. Tied to THIS child's next
 * steps and interests, not general advice. HOME_IDEA_EXAMPLES below is given to
 * the model as the register to write in, and it is drawn verbatim from
 * src/routes/study.js so the voice is Wren's existing one rather than a new one.
 *
 * ── SOVEREIGNTY ─────────────────────────────────────────────────────────────
 * Named child, developmental detail, a document that goes to a family. Runs on
 * the Ascent via src/lib/sovereign-model.js, which refuses any host that is not
 * private or Tailscale. AI_PROVIDER is deliberately not read: a demo edition
 * configured for Groq drafts locally or not at all.
 */

// Required lazily for the same reason as b243: sovereign-model.js asserts its
// host at REQUIRE time, so a bad OLLAMA_HOST would take down the whole server
// mount rather than failing one draft.
function sovereign() { return require('./sovereign-model'); }

let canonicalArea;
try { ({ canonicalArea } = require('./area-gather')); } catch (_) { canonicalArea = () => null; }

const TC = require('./termly-cycle');

// ai-models.js role 'heavy', resolved per draft (b333), so it moves with
// settings.ai_model_overrides. The host is still sovereign-model.js's to check.
const ai = require('./ai-models');
const ROLE = 'heavy';
const TIMEOUT_MS = parseInt(process.env.TERMLY_UPDATE_TIMEOUT_MS || '300000', 10);

// ── The five sections ────────────────────────────────────────────────────────
// `key` goes in reports.content.sections[].key and never changes once shipped.
// `modelled` is whether the local model is asked at all.
const SECTIONS = [
  { key: 'went_well',  heading: 'What went well last term',            modelled: true },
  { key: 'working_on', heading: 'What we\'re working on this term',    modelled: true },
  { key: 'next_steps', heading: 'Next steps',                          modelled: false },
  { key: 'at_home',    heading: 'Things you could try at home',        modelled: true },
  { key: 'tracking',   heading: 'Where things are in the tracker',     modelled: false },
];
const SECTION_KEYS = SECTIONS.map(s => s.key);

// All seven areas, unlike b243 which is statutorily restricted to the three
// prime ones. A termly update is the whole picture.
const AREAS = [
  { key: 'communication_language', heading: 'Communication and language', canonical: 'Communication & Language', match: /^(c\s*&?\s*l|cl|communication)/i },
  { key: 'physical_development',   heading: 'Physical development',       canonical: 'Physical Development',     match: /^(pd|physical)/i },
  { key: 'pse_development',        heading: 'Personal, social and emotional development', canonical: 'Personal, Social & Emotional Development', match: /^(psed?|pse|personal)/i },
  { key: 'literacy',               heading: 'Literacy',                   canonical: 'Literacy',                 match: /^(lit|literacy|reading|writing)/i },
  { key: 'mathematics',            heading: 'Mathematics',                canonical: 'Mathematics',              match: /^(math|maths|numeracy|m$)/i },
  { key: 'understanding_world',    heading: 'Understanding the world',    canonical: 'Understanding the World',  match: /^(uw|understanding)/i },
  { key: 'expressive_arts',        heading: 'Expressive arts and design', canonical: 'Expressive Arts & Design', match: /^(ead|ea&d|expressive|art)/i },
];

// Statuses in ladn.framework_tracker, weakest first. 'observed' and 'emerging'
// both appear in the data (88 and 1 rows in wren_dev) and mean roughly the same
// thing at different points in the tracker's history, so they are ranked
// together rather than one being treated as an unknown.
const TRACKER_ORDER = ['not_yet', 'emerging', 'observed', 'developing', 'secure'];
const TRACKER_LABEL = {
  not_yet: 'not yet', emerging: 'just emerging', observed: 'seen once or twice',
  developing: 'developing', secure: 'secure',
};

const MAX_LOOKBACK_DAYS = 200;   // a cycle's look-back never reaches further than this

// ── Dates ────────────────────────────────────────────────────────────────────
// LOCAL getters throughout — see memory/reference_pg_date_ymd_trap.md.
const ymd = TC.ymd;
function longDate(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
function ageInMonths(dob, on) {
  if (!dob) return null;
  const d = (dob instanceof Date) ? dob : new Date(dob);
  const t = on ? ((on instanceof Date) ? on : new Date(on)) : new Date();
  if (isNaN(d) || isNaN(t)) return null;
  let m = (t.getFullYear() - d.getFullYear()) * 12 + (t.getMonth() - d.getMonth());
  if (t.getDate() < d.getDate()) m -= 1;
  return m;
}

// ── Edition gate ─────────────────────────────────────────────────────────────
// Same three lines as b243's, and duplicated for the same reason: importing them
// from src/routes/setup.js would drag an Express router in for a string compare.
function editionFamily() {
  const fam = String(process.env.WREN_EDITION_FAMILY || '').toLowerCase();
  if (['eyfs', 'primary', 'secondary'].includes(fam)) return fam;
  const ed = String(process.env.WREN_EDITION || '').toLowerCase();
  const schema = String(process.env.PG_SCHEMA || '').toLowerCase();
  if (ed === 'secondary' || schema.includes('secondary')) return 'secondary';
  if (ed === 'primary' || ed === 'ht' || schema.includes('primary')) return 'primary';
  return 'eyfs';
}
function isEyfsEdition() { return editionFamily() === 'eyfs'; }

function roleLabel(role) {
  return String(role || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Which of the seven areas does a practitioner's spelling belong to? */
function areaKey(label) {
  const raw = String(label == null ? '' : label).trim();
  if (!raw) return null;
  const canon = canonicalArea(raw);
  if (canon) { const hit = AREAS.find(a => a.canonical === canon); if (hit) return hit.key; }
  const hit = AREAS.find(a => a.match.test(raw));
  return hit ? hit.key : null;
}
const AREA_BY_KEY = AREAS.reduce((m, a) => (m[a.key] = a, m), {});

// ═══════════════════════════════════════════════════════════════════════════
// Evidence
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Everything Wren holds about this child that belongs in this cycle's update.
 * Deterministic — no model involved — so the same child and cycle always produce
 * the same evidence pack, and every entry carries the id of the row behind it.
 *
 * TWO WINDOWS, and keeping them apart is most of the value of this function:
 *
 *   LAST TERM   cycle.reviews_from … cycle.reviews_to   → section 1
 *   THIS TERM   cycle.opens_on      … `on`              → sections 2 and 3
 *
 * Section 1 must never be written from records made after the term it is about,
 * and section 2 must never be padded out with last term's material to hide the
 * fact that this term is three days old. Merging the windows would let both
 * happen silently.
 *
 * @param {object} db      pg pool (search_path set by src/db/pool.js)
 * @param {number} childId
 * @param {object} cycle   from src/lib/termly-cycle.js
 * @param {object} [opts]  { on: 'YYYY-MM-DD' — "as at", for testing }
 */
async function gatherEvidence(db, childId, cycle, opts = {}) {
  if (!cycle) throw new Error('No termly-update cycle for this date — the school term calendar does not cover it.');
  const on = ymd(opts.on) || TC.ymd(new Date());

  const childRes = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
           c.start_date, c.leave_date, c.room_id, c.key_person_id,
           r.name AS room_name,
           kp.first_name AS kp_first, kp.last_name AS kp_last, kp.role AS kp_role
      FROM children c
      LEFT JOIN rooms r  ON r.id = c.room_id
      LEFT JOIN staff kp ON kp.id = c.key_person_id
     WHERE c.id = $1`, [childId]);
  if (!childRes.rows.length) throw new Error('Child not found');
  const c = childRes.rows[0];

  // Never reach back before the child joined us — we cannot write about what
  // happened somewhere else — and never further than MAX_LOOKBACK_DAYS, which
  // matters for the first cycle in a calendar, whose look-back is a synthetic
  // eight weeks rather than a real previous half-term.
  const start = ymd(c.start_date);
  const floor = TC.addWeeks(cycle.opens_on, -Math.ceil(MAX_LOOKBACK_DAYS / 7));
  let lastFrom = cycle.reviews_from > floor ? cycle.reviews_from : floor;
  if (start && start > lastFrom) lastFrom = start;

  /* ── b359: opts.allHistory — "it looks at ALL their previous observations" ──
   * Toby, 2026-09-29. The default (b246) window is the previous half-term, which
   * is right for the ordinary cycle: a termly update is about a term. The
   * per-key-person run asks a different question — "where is this child now,
   * across everything we have ever written about them" — and for that the floor
   * has to come off.
   *
   * It comes off only as far as the child's START DATE. We still cannot write
   * about what happened somewhere else, and reaching back past it would pull in
   * an EyLog import belonging to a previous setting.
   *
   * The LIMIT is what actually bounds this, not the date: a child with four
   * years here has several hundred observations, and an unbounded prompt is
   * silently truncated by the model's context window in the middle of a
   * sentence. historyLimit (ladn.settings.termly_draft_history_limit, 160) caps
   * it newest-first, and the caller is told when it bit (see ev.history). */
  const allHistory = !!(opts && opts.allHistory);
  const historyLimit = Math.max(20, Math.min(400,
    parseInt(opts && opts.historyLimit, 10) || 160));
  const OBS_LIMIT = allHistory ? historyLimit : 80;
  const NS_LIMIT  = allHistory ? historyLimit : 60;
  const PREV_LIMIT = allHistory ? 6 : 1;
  if (allHistory) lastFrom = start || '1900-01-01';

  const lastTo = cycle.reviews_to;
  const thisFrom = cycle.opens_on;
  const thisTo = on > cycle.closes_on ? cycle.closes_on : on;

  const [obsRes, nsRes, paRes, trkRes, aboutRes, tagRes, prevRes, rangeRes] = await Promise.all([
    // Published observations across BOTH windows in one query, split below on the
    // date. A draft or returned observation is not yet an agreed record.
    db.query(`
      SELECT o.id, o.title, o.observation_text, o.analysis, o.next_steps,
             o.eyfs_areas, o.created_at, o.termly_update,
             COALESCE(o.author_name, s.first_name || ' ' || s.last_name) AS author_name
        FROM observations o
        LEFT JOIN staff s ON s.id = o.staff_id
       WHERE o.child_id = $1
         AND o.created_at >= $2::date
         AND o.created_at < ($3::date + 1)
         AND COALESCE(o.review_status, 'published') = 'published'
         AND COALESCE(o.dsl_only, false) = false
       ORDER BY o.created_at DESC
       LIMIT ${OBS_LIMIT}`, [childId, lastFrom, thisTo]),

    // Next steps: everything live or recently closed. The status is what decides
    // which section each one lands in, not the date.
    db.query(`
      SELECT n.id, n.description, n.status, n.due_by, n.created_at, n.updated_at,
             n.resource_card_slug, n.resource_card_title, n.library_activity_id,
             n.planned_activity_id, n.source_report_id,
             n.framework_statement_id, fs.area AS fs_area,
             ca.name AS activity_name, ca.description AS activity_description,
             o.eyfs_areas AS obs_areas
        FROM next_steps n
        LEFT JOIN framework_statements fs ON fs.id = n.framework_statement_id
        LEFT JOIN curriculum_activities ca ON ca.id = n.library_activity_id
        LEFT JOIN observations o ON o.id = n.observation_id
       WHERE n.child_id = $1
         AND (n.status = 'pending' OR n.updated_at >= $2::date)
       ORDER BY (n.status = 'pending') DESC, n.updated_at DESC NULLS LAST, n.created_at DESC
       LIMIT ${NS_LIMIT}`, [childId, lastFrom]),

    db.query(`
      SELECT p.id, p.plan_date, p.status,
             COALESCE(p.title, p.custom_title, ca.name) AS title,
             COALESCE(p.description, p.custom_notes, ca.description) AS description,
             ca.eyfs_areas AS activity_areas,
             n.description AS next_step_text, fs.area AS ns_area
        FROM planned_activities p
        LEFT JOIN curriculum_activities ca ON ca.id = p.activity_id
        LEFT JOIN next_steps n ON n.id = p.next_step_id
        LEFT JOIN framework_statements fs ON fs.id = n.framework_statement_id
       WHERE p.child_id = $1 AND p.plan_date >= $2::date AND p.plan_date <= $3::date
       ORDER BY p.plan_date DESC
       LIMIT 40`, [childId, lastFrom, thisTo]),

    // The whole tracker, not a window. Section 5 is "where this child IS", which
    // is a cumulative position; `assessed_at` is used below to work out what MOVED.
    db.query(`
      SELECT t.id, t.framework, t.area, t.aspect, t.age_range, t.statement,
             t.status, t.assessed_at, t.notes
        FROM framework_tracker t
       WHERE t.child_id = $1 AND COALESCE(t.framework,'') <> 'coel'
       ORDER BY t.assessed_at DESC NULLS LAST, t.id DESC
       LIMIT 800`, [childId]),

    db.query(`SELECT interests, skills, favourite_toys_activities, comforts
                FROM child_about_me WHERE child_id = $1
               ORDER BY last_updated_at DESC NULLS LAST LIMIT 1`, [childId])
      .catch(() => ({ rows: [] })),

    db.query(`SELECT tag, tag_category FROM child_tags WHERE child_id = $1 LIMIT 15`, [childId])
      .catch(() => ({ rows: [] })),

    // The previous b246 update, so the draft can say whether last term's next
    // steps were met rather than starting from nothing every cycle.
    db.query(`
      SELECT id, cycle_key, content, sent_at
        FROM reports
       WHERE child_id = $1 AND report_type = 'termly_update'
         AND cycle_key IS NOT NULL AND cycle_key <> $2
       ORDER BY created_at DESC LIMIT ${PREV_LIMIT}`, [childId, cycle.key])
      .catch(() => ({ rows: [] })),

    /* b278/b291 — the RANGE recorded for each area, and how secure the child is
     * judged to be in it. Latest per area, whichever moment recorded it: a range
     * set on a progress report in November is still where the child is when the
     * termly update goes out in December, and pretending otherwise would make
     * section 5 contradict the report the family already has.
     *
     * Guarded: an instance without b278's table still produces an update. */
    db.query(`
      SELECT DISTINCT ON (framework, area)
             framework, area, range_ordinal, range_label, security, context, judged_on
        FROM child_range_judgements
       WHERE child_id = $1
       ORDER BY framework, area, judged_on DESC, id DESC`, [childId])
      .catch(() => ({ rows: [] })),
  ]);

  // ── Index every record under a stable citation ref ─────────────────────────
  const index = {};
  const lastTerm = { observations: [], planned: [], next_steps_completed: [] };
  const thisTerm = { observations: [], planned: [] };

  const obsItem = (o) => {
    const ref = `OBS-${o.id}`;
    const areas = (Array.isArray(o.eyfs_areas) ? o.eyfs_areas : [])
      .map(areaKey).filter(Boolean);
    const item = {
      ref, id: o.id, date: ymd(o.created_at), title: o.title || null,
      text: String(o.observation_text || '').trim(),
      analysis: o.analysis ? String(o.analysis).trim() : null,
      author: o.author_name || null,
      termly_update: !!o.termly_update,
      areas: [...new Set(areas)],
    };
    index[ref] = { type: 'observation', id: o.id, date: item.date, label: item.title || 'Observation' };
    return item;
  };
  for (const o of obsRes.rows) {
    const item = obsItem(o);
    if (item.date && item.date >= thisFrom) thisTerm.observations.push(item);
    else if (item.date && item.date >= lastFrom && item.date <= lastTo) lastTerm.observations.push(item);
  }

  const openSteps = [], closedSteps = [];
  for (const n of nsRes.rows) {
    const ref = `NS-${n.id}`;
    let key = areaKey(n.fs_area);
    if (!key && Array.isArray(n.obs_areas)) { for (const a of n.obs_areas) { key = areaKey(a); if (key) break; } }
    const item = {
      ref, id: n.id, description: String(n.description || '').trim(),
      status: n.status, area: key, area_label: key ? AREA_BY_KEY[key].heading : null,
      due_by: ymd(n.due_by), created: ymd(n.created_at), updated: ymd(n.updated_at),
      // What the keyperson has already attached. This is the b245 link: the same
      // card and activity libraries the room planner uses, chosen for one child.
      resource_card_slug: n.resource_card_slug || null,
      resource_card_title: n.resource_card_title || null,
      library_activity_id: n.library_activity_id || null,
      library_activity_name: n.activity_name || null,
      library_activity_description: n.activity_description || null,
      planned_activity_id: n.planned_activity_id || null,
      source_report_id: n.source_report_id || null,
    };
    index[ref] = { type: 'next_step', id: n.id, date: item.created, label: item.description.slice(0, 90) };
    if (n.status === 'pending') openSteps.push(item);
    else { closedSteps.push(item); if (n.status === 'completed') lastTerm.next_steps_completed.push(item); }
  }

  for (const p of paRes.rows) {
    const ref = `PA-${p.id}`;
    let key = areaKey(p.ns_area);
    if (!key && Array.isArray(p.activity_areas)) { for (const a of p.activity_areas) { key = areaKey(a); if (key) break; } }
    const item = { ref, id: p.id, date: ymd(p.plan_date), title: p.title || null,
                   description: p.description ? String(p.description).trim() : null,
                   status: p.status || 'planned', area: key, from_next_step: p.next_step_text || null };
    index[ref] = { type: 'planned_activity', id: p.id, date: item.date, label: item.title || 'Planned activity' };
    if (item.date >= thisFrom) thisTerm.planned.push(item); else lastTerm.planned.push(item);
  }

  // ── The tracker ───────────────────────────────────────────────────────────
  const tracker = { total: 0, by_status: {}, by_area: {}, moved: [], framework: null };
  for (const s of TRACKER_ORDER) tracker.by_status[s] = 0;
  for (const t of trkRes.rows) {
    const key = areaKey(t.area);
    const status = TRACKER_ORDER.includes(t.status) ? t.status : 'not_yet';
    tracker.total++;
    tracker.by_status[status]++;
    if (!tracker.framework && t.framework) tracker.framework = t.framework;
    const bucket = tracker.by_area[key || 'other'] || (tracker.by_area[key || 'other'] = {
      key: key || 'other', heading: key ? AREA_BY_KEY[key].heading : 'Other',
      total: 0, not_yet: 0, emerging: 0, observed: 0, developing: 0, secure: 0, last_assessed: null,
    });
    bucket.total++; bucket[status]++;
    const assessed = ymd(t.assessed_at);
    if (assessed && (!bucket.last_assessed || assessed > bucket.last_assessed)) bucket.last_assessed = assessed;

    // What moved in the window this update is about — the part a parent actually
    // wants, as opposed to a cumulative count that looks identical every term.
    if (assessed && assessed >= lastFrom && status !== 'not_yet') {
      const ref = `TRK-${t.id}`;
      index[ref] = { type: 'framework_tracker', id: t.id, date: assessed, label: String(t.statement || '').slice(0, 90) };
      tracker.moved.push({
        ref, id: t.id, area: key, area_label: key ? AREA_BY_KEY[key].heading : (t.area || null),
        aspect: t.aspect || null, age_range: t.age_range || null,
        statement: String(t.statement || '').trim(), status, assessed,
        notes: t.notes ? String(t.notes).trim() : null,
      });
    }
  }
  tracker.moved.sort((a, b) => b.assessed.localeCompare(a.assessed));
  tracker.areas = Object.values(tracker.by_area).sort((a, b) => b.total - a.total);

  /* ── b291: the RANGE, and how secure in it ────────────────────────────────
   * The tracker above counts STATEMENTS. This is the other half of section 5 —
   * the range a practitioner recorded for the whole area, plus their judgement
   * of how secure the child is inside it. Both are facts off the record; the
   * model is never asked to write either (section 5 is not modelled).
   *
   * `security: null` means NOT YET RATED and is carried through as null. It is
   * never turned into 'emerging' — nobody made that judgement, and a parent
   * reading "emerging" would be reading something we invented. */
  const SEC_LABEL = { emerging: 'Emerging', developing: 'Developing', secure: 'Secure' };
  const ranges = {
    framework: null,
    framework_label: null,
    areas: [],
    rated: 0,
    unrated: 0,
  };
  for (const r of (rangeRes.rows || [])) {
    if (!ranges.framework) ranges.framework = r.framework;
    // One framework per update — the one the most recent judgements are in.
    if (r.framework !== ranges.framework) continue;
    const key = areaKey(r.area);
    const sec = SEC_LABEL[r.security] ? r.security : null;
    if (sec) ranges.rated++; else ranges.unrated++;
    ranges.areas.push({
      area: r.area,
      area_key: key,
      area_label: key ? AREA_BY_KEY[key].heading : r.area,
      range_ordinal: r.range_ordinal,
      range_label: r.range_label,
      security: sec,
      // The words a parent reads. "Not yet rated" is a real answer, and is what
      // an unrated judgement says — never a blank, never "Emerging".
      security_label: sec ? SEC_LABEL[sec] : 'Not yet rated',
      context: r.context,
      judged_on: ymd(r.judged_on),
    });
  }
  ranges.any = ranges.areas.length > 0;

  // ── Interests, for section 4 ──────────────────────────────────────────────
  const about = aboutRes.rows[0] || {};
  const interests = {
    interests: about.interests || null,
    favourites: about.favourite_toys_activities || null,
    skills: about.skills || null,
    comforts: about.comforts || null,
    tags: (tagRes.rows || []).map(t => t.tag).filter(Boolean),
  };
  interests.any = !!(interests.interests || interests.favourites || interests.skills || interests.tags.length);

  // ── Last term's update, for continuity ────────────────────────────────────
  // b359: `previous` is still the MOST RECENT one and has exactly the shape it
  // had before — every existing reader of it is untouched. `previous_all` is the
  // new list, and it is empty unless opts.allHistory asked for it, so a b246
  // draft carries not one byte more than it did.
  const asPrev = (p) => {
    const pc = (typeof p.content === 'string') ? safeParse(p.content) : (p.content || {});
    const secs = Array.isArray(pc.sections) ? pc.sections : [];
    const steps = (pc.next_steps && Array.isArray(pc.next_steps.items)) ? pc.next_steps.items : [];
    return {
      id: p.id, cycle_key: p.cycle_key, sent_at: p.sent_at,
      cycle_label: pc.cycle && pc.cycle.label ? pc.cycle.label : p.cycle_key,
      next_steps: steps.map(s => ({ description: s.description, next_step_id: s.next_step_id || null })),
      working_on: (secs.find(s => s.key === 'working_on') || {}).body || null,
      went_well: (secs.find(s => s.key === 'went_well') || {}).body || null,
    };
  };
  const previousAll = prevRes.rows.map(asPrev);
  let previous = previousAll.length ? previousAll[0] : null;

  const dob = ymd(c.date_of_birth);
  return {
    generated_at: new Date().toISOString(),
    on,
    cycle,
    windows: {
      last_term: { from: lastFrom, to: lastTo, is_previous_half_term: cycle.reviews_is_previous_half_term,
                   label: cycle.reviews ? cycle.reviews.name : 'the weeks before this term' },
      this_term: { from: thisFrom, to: thisTo, label: cycle.name },
    },
    child: {
      id: c.id, first_name: c.first_name, last_name: c.last_name,
      preferred_name: c.preferred_name || null,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      known_as: (c.preferred_name || c.first_name || '').trim(),
      date_of_birth: dob, age_months: ageInMonths(dob, on),
      start_date: start, leave_date: ymd(c.leave_date),
      room_id: c.room_id, room_name: c.room_name || null,
    },
    keyperson: c.key_person_id
      ? { id: c.key_person_id, name: `${c.kp_first || ''} ${c.kp_last || ''}`.trim(), role: c.kp_role || null }
      : null,
    last_term: lastTerm,
    this_term: thisTerm,
    open_next_steps: openSteps,
    closed_next_steps: closedSteps,
    tracker,
    ranges,
    interests,
    previous,
    // b359 — every earlier termly update we still hold, newest first. [] unless
    // opts.allHistory asked for them.
    previous_all: previousAll,
    /* b359 — what the look-back actually covered, so the page can say
     * "42 observations since March 2024" rather than implying it read
     * everything when the cap bit. `truncated` is true when the query came back
     * full, which is the only honest way to know a record was left out. */
    history: {
      all: allHistory,
      from: lastFrom,
      observation_limit: OBS_LIMIT,
      next_step_limit: NS_LIMIT,
      truncated: obsRes.rows.length >= OBS_LIMIT || nsRes.rows.length >= NS_LIMIT,
      observations_read: obsRes.rows.length,
      next_steps_read: nsRes.rows.length,
      previous_updates_read: previousAll.length,
      termly_updates_in_history: obsRes.rows.filter(o => o.termly_update).length,
    },
    index,
    counts: {
      observations_last_term: lastTerm.observations.length,
      observations_this_term: thisTerm.observations.length,
      next_steps_open: openSteps.length,
      next_steps_completed_last_term: lastTerm.next_steps_completed.length,
      planned_last_term: lastTerm.planned.length,
      planned_this_term: thisTerm.planned.length,
      tracker_statements: tracker.total,
      tracker_moved: tracker.moved.length,
      ranges_recorded: ranges.areas.length,
      ranges_rated: ranges.rated,
      ranges_unrated: ranges.unrated,
    },
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// ═══════════════════════════════════════════════════════════════════════════
// Is there enough to write about?
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The bar, per section. Deliberately different per section, because "enough" is
 * a different question for each of them.
 *
 * went_well   at least ONE observation from last term, or one next step
 *             completed in it. Without either, there is no term to report on.
 * working_on  at least one open next step OR one observation this term. An
 *             update whose middle section is invented is worse than one that
 *             says the term has only just started.
 * at_home     needs something to hang an idea on: an open next step, or the
 *             family's own record of what the child likes. General advice a
 *             parent could have got from a leaflet is not worth sending.
 */
function sufficiency(ev) {
  const wentWell = ev.last_term.observations.length + ev.last_term.next_steps_completed.length;
  const workingOn = ev.open_next_steps.length + ev.this_term.observations.length;
  return {
    went_well: {
      sufficient: wentWell >= 1,
      observations: ev.last_term.observations.length,
      completed_next_steps: ev.last_term.next_steps_completed.length,
      tracker_moved: ev.tracker.moved.filter(m => m.assessed <= ev.windows.last_term.to).length,
    },
    working_on: {
      sufficient: workingOn >= 1,
      open_next_steps: ev.open_next_steps.length,
      observations: ev.this_term.observations.length,
    },
    next_steps: {
      sufficient: ev.open_next_steps.length >= 1,
      open_next_steps: ev.open_next_steps.length,
    },
    at_home: {
      sufficient: ev.open_next_steps.length >= 1 || ev.interests.any,
      open_next_steps: ev.open_next_steps.length,
      interests: ev.interests.any,
    },
    tracking: {
      // b291: a recorded RANGE is enough on its own. A setting can have ranged a
      // child on their progress report without having ticked a single statement,
      // and "where they are in their learning" is answerable from that.
      sufficient: ev.tracker.total >= 1 || (ev.ranges && ev.ranges.areas.length >= 1),
      statements: ev.tracker.total,
      ranges: (ev.ranges && ev.ranges.areas.length) || 0,
      moved: ev.tracker.moved.length,
    },
  };
}

/**
 * What a section says when there is not enough behind it.
 *
 * These are written HERE, deterministically, and every one of them names what is
 * missing and who will do something about it. "Not enough recorded yet" is a
 * true sentence a parent can act on; a paragraph of warm generalities is not.
 */
function gapText(key, ev) {
  const who = ev.child.known_as || 'your child';
  const kp = ev.keyperson ? ev.keyperson.name.split(' ')[0] : 'their key person';
  const lastLabel = ev.windows.last_term.label;
  switch (key) {
    case 'went_well':
      return `We have not recorded enough about ${who} during ${lastLabel} to write honestly about how it went. `
           + `Rather than fill this in with something we cannot show you, we have left it open — ${kp} will talk you `
           + `through what they have noticed day to day, and this section will have more in it next time.`;
    case 'working_on':
      return `${ev.windows.this_term.label} has only just started and we have not yet agreed what we are focusing on with `
           + `${who} this term. ${kp} will set that out with you in the next week or two, and it will be here in the next update.`;
    case 'next_steps':
      return `There are no next steps recorded for ${who} at the moment. ${kp} will add them before this update is sent.`;
    case 'at_home':
      return `${kp} will add one or two simple things you could try at home. If you would like ideas for something in `
           + `particular, just ask — and please tell us what ${who} has been enjoying at home, because that is where most `
           + `of our best ideas come from.`;
    case 'tracking':
      return `We have not yet recorded any tracker statements or age ranges for ${who}. Their key person assesses these as `
           + `they observe ${who} across the seven areas of learning, and there will be a picture here once that has begun.`;
    default:
      return 'Not enough recorded yet.';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The deterministic sections
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Section 3 — next steps. Never modelled: what the setting commits to doing next
 * with a child is a professional judgement, and each one carries the resource
 * card or activity the keyperson chose for it.
 *
 * Returned as STRUCTURE as well as prose: content.next_steps.items is what the
 * review screen edits and what the card picker writes back to, while `body` is
 * what prints. The two are kept in step by renderNextSteps().
 */
function renderNextSteps(items, ev) {
  const who = ev.child.known_as || 'your child';
  if (!items.length) return gapText('next_steps', ev);
  const lines = [`What we will be working on with ${who} this term:`, ''];
  for (const n of items) {
    lines.push('• ' + n.description + (n.area_label ? ` (${n.area_label})` : ''));
    const extras = [];
    if (n.resource_card_title) extras.push(`we will use our "${n.resource_card_title}" activity card`);
    if (n.library_activity_name) extras.push(`we have planned "${n.library_activity_name}"`);
    if (extras.length) lines.push('   ' + extras.join(', ') + '.');
  }
  return lines.join('\n');
}

/**
 * Section 5 — the tracking data, included IN the update rather than living on a
 * separate screen (Toby, 2026-08-28).
 *
 * Two halves, and the second one is the point. A cumulative count of secure
 * statements looks almost identical every term and tells a family nothing; what
 * MOVED since last term is the actual news. The counts are there because a
 * parent asked "where is my child overall" deserves an answer too.
 */
function renderTracking(ev) {
  const who = ev.child.known_as || 'your child';
  const t = ev.tracker;
  const r = ev.ranges || { areas: [] };
  if (!t.total && !r.areas.length) return gapText('tracking', ev);
  const lines = [];

  /* b291 — the RANGE half, first, because it is the answer to the question a
   * parent actually asks. Two facts per area, both off the record: which age
   * range their key person judges this child to be working in, and how secure
   * they are inside it.
   *
   * An area with no security rating says "we have not rated this yet". It is
   * NEVER written as "emerging" — that would be us inventing a judgement, which
   * is exactly what this file exists to prevent. */
  if (r.areas.length) {
    lines.push(`Their key person records which age range ${who} is working in for each area of learning, and how secure `
      + `they are in it. Secure means doing it independently and consistently; developing means with support or not yet `
      + `consistently; emerging means just beginning to show it. None of them is behind — they are where ${who} is now.`);
    lines.push('');
    for (const a of r.areas) {
      const range = String(a.range_label || '').replace(/\s*\(/, ' (');
      lines.push(a.security
        ? `${a.area_label}: ${range} — ${a.security_label.toLowerCase()}.`
        : `${a.area_label}: ${range} — how secure has not been rated yet.`);
    }
    if (r.unrated && r.rated) {
      lines.push('');
      lines.push(`Where an area says "not rated yet", the range is recorded but the judgement about how secure ${who} is `
        + `in it has not been made — it will be before the next update.`);
    }
    lines.push('');
  }

  if (!t.total) return lines.join('\n').trim();

  lines.push(`We also track ${who} against the individual Development Matters statements. This is where things stand — `
    + `it is a picture of what we have seen so far, not a score, and every child moves through it at their own pace.`);
  lines.push('');
  for (const a of t.areas) {
    if (a.key === 'other' && t.areas.length > 1) continue;
    const seen = a.secure + a.developing + a.observed + a.emerging;
    lines.push(`${a.heading}: ${a.secure} secure, ${a.developing} developing, ${a.total - seen} not yet seen (of ${a.total}).`);
  }
  const moved = t.moved.filter(m => m.assessed >= ev.windows.last_term.from);
  lines.push('');
  if (moved.length) {
    lines.push(`Moved on since ${longDate(ev.windows.last_term.from)}:`);
    for (const m of moved.slice(0, 12)) {
      lines.push(`• ${m.statement} — now ${TRACKER_LABEL[m.status] || m.status}${m.area_label ? ` (${m.area_label})` : ''}`);
    }
    if (moved.length > 12) lines.push(`• …and ${moved.length - 12} more.`);
  } else {
    lines.push(`Nothing new has been assessed in the tracker since ${longDate(ev.windows.last_term.from)}. `
      + `That does not mean nothing has happened — it means we have not caught up with recording it, and `
      + `${ev.keyperson ? ev.keyperson.name.split(' ')[0] : 'their key person'} will be doing that this term.`);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// The prompts
// ═══════════════════════════════════════════════════════════════════════════
const SYSTEM = [
  'You are helping an early years practitioner in an English nursery write a child\'s progress update.',
  'Your draft will be read, edited and approved by that practitioner before any parent sees it.',
  '',
  'ABSOLUTE RULES:',
  '1. Write ONLY what the supplied records support. Never infer, extrapolate or invent anything a child',
  '   did, said, enjoyed or achieved. If the records do not show it, do not write it.',
  '2. Cite the reference in square brackets (for example [OBS-412]) after each factual claim. Use only',
  '   references that appear in the records you are given. Never copy a bracketed word that is not a',
  '   reference.',
  '3. Write warmly and plainly, for a parent, in British English. Use the child\'s name. No jargon, no',
  '   acronyms, no EYFS or Ofsted language, no headings.',
  '4. Be honest. A parent would rather read "we are still working on this" than a paragraph of praise',
  '   with nothing behind it.',
].join('\n');

function evidenceLines(items, kind) {
  const out = [];
  for (const o of items) {
    if (kind === 'obs') {
      const bits = [o.text];
      if (o.analysis) bits.push(`Practitioner note: ${o.analysis}`);
      out.push(`[${o.ref}] ${o.date} — ${o.title ? o.title + ': ' : ''}${bits.join(' ')}`.slice(0, 900));
    } else if (kind === 'ns') {
      out.push(`[${o.ref}] Next step (${o.status}): ${o.description}`.slice(0, 300));
    } else if (kind === 'pa') {
      out.push(`[${o.ref}] Activity ${o.date}: ${o.title || ''}${o.description ? ' — ' + o.description : ''}`.slice(0, 300));
    } else if (kind === 'trk') {
      out.push(`[${o.ref}] ${o.assessed} — ${o.statement} is now ${TRACKER_LABEL[o.status] || o.status}`.slice(0, 300));
    }
  }
  return out;
}

/* b359 — the "everything we have ever written" block.
 *
 * Returns '' unless gatherEvidence ran with opts.allHistory, so a b246 draft's
 * prompt is byte-for-byte what it was. When it IS on, this is what makes the
 * draft say "a year ago they would not join a group and now they lead one"
 * rather than describing one half-term as if it were the whole child.
 *
 * It carries HEADLINES, not the records: the observations themselves are
 * already in the section prompts, and repeating them would spend the context
 * window twice on the same text. */
function historyBlock(ev) {
  if (!ev.history || !ev.history.all) return '';
  const h = ev.history;
  const lines = [`Everything on record for this child since ${h.from}: `
    + `${h.observations_read} observations, ${h.next_steps_read} next steps, `
    + `${h.previous_updates_read} previous termly updates.`];
  if (h.truncated) {
    lines.push('(That is the most recent of them — there are older records than these.)');
  }
  for (const p of (ev.previous_all || []).slice(0, 4)) {
    const bits = [];
    if (p.went_well)  bits.push(String(p.went_well).replace(/\s+/g, ' ').slice(0, 320));
    if (p.working_on) bits.push(String(p.working_on).replace(/\s+/g, ' ').slice(0, 320));
    if (bits.length) lines.push(`Previously (${p.cycle_label || p.cycle_key}): ${bits.join(' … ')}`);
  }
  if (lines.length === 1) return '';
  return ['', 'THE LONGER VIEW — what we have said before:', ...lines, ''].join('\n');
}

function wentWellPrompt(ev) {
  const name = ev.child.known_as || ev.child.first_name;
  const w = ev.windows.last_term;
  const lines = [
    ...evidenceLines(ev.last_term.observations.slice(0, 14), 'obs'),
    ...evidenceLines(ev.last_term.next_steps_completed.slice(0, 10), 'ns'),
    ...evidenceLines(ev.last_term.planned.slice(0, 6), 'pa'),
    ...evidenceLines(ev.tracker.moved.filter(m => m.assessed <= w.to).slice(0, 12), 'trk'),
  ];
  return [
    `Child: ${name}${ev.child.age_months != null ? `, aged ${ev.child.age_months} months` : ''}.`,
    `Write about ${w.label} — the records below cover ${w.from} to ${w.to}.`,
    historyBlock(ev),
    '',
    lines.length ? lines.join('\n') : '(no records)',
    '',
    `Write TWO short paragraphs (110-170 words in total) for ${name}'s parents about how last term went:`,
    '  • what they got stuck into and enjoyed, and what they can do now that they could not before;',
    '  • which of the things we were working on last term have come good, and which have not yet.',
    'Use references. Do not describe anything that is not in the records above.',
  ].join('\n');
}

function workingOnPrompt(ev) {
  const name = ev.child.known_as || ev.child.first_name;
  const lines = [
    ...evidenceLines(ev.open_next_steps.slice(0, 12), 'ns'),
    ...evidenceLines(ev.this_term.observations.slice(0, 8), 'obs'),
    ...evidenceLines(ev.this_term.planned.slice(0, 8), 'pa'),
  ];
  return [
    `Child: ${name}${ev.child.age_months != null ? `, aged ${ev.child.age_months} months` : ''}.`,
    `This term is ${ev.windows.this_term.label} (${ev.windows.this_term.from} to ${ev.cycle.closes_on}).`,
    ev.previous && ev.previous.working_on
      ? `Last term we told the family: "${String(ev.previous.working_on).slice(0, 500)}"`
      : '',
    historyBlock(ev),
    '',
    'What we are working on, and what is already planned:',
    lines.length ? lines.join('\n') : '(no records)',
    '',
    `Write ONE short paragraph (80-130 words) for ${name}'s parents explaining what we are focusing on with`,
    'them this term and why — grounded in the next steps above. Say what it will look like in the room:',
    'the sort of play and activities we will put out. Use references.',
    'Do not list the next steps as bullets; they are printed separately underneath.',
  ].filter(Boolean).join('\n');
}

/**
 * The register for section 4, lifted verbatim from src/routes/study.js's activity
 * vouchers — the "examples on wren" Toby pointed at. Given to the model as
 * examples of TONE AND SHAPE only; it is told in the same breath not to reuse
 * their content, because a Kitchen Science Morning is not a next step for every
 * child in the nursery.
 */
const HOME_IDEA_EXAMPLES = [
  'Sound Safari Walk — You need: a notebook or clipboard, a pencil. 1. Go for a walk around your '
  + 'neighbourhood. 2. Listen carefully for sounds: birds, traffic, voices, wind. 3. For each sound, write '
  + 'or draw it. 4. Back home, sort them into loud, quiet, natural and man-made. Tell us: one new sound word '
  + 'you discovered.',
  'Feelings Weather Chart — You need: a large piece of paper, coloured pens. 1. Draw weather symbols: '
  + 'sunshine, clouds, rain, storm, rainbow. 2. Each morning ask "what is your weather today?" 3. They choose '
  + 'the symbol that matches how they feel. 4. Talk about why. Celebrate all weathers equally, there is no '
  + 'wrong feeling. Tell us: what your weather was this morning.',
];

function atHomePrompt(ev) {
  const name = ev.child.known_as || ev.child.first_name;
  const bits = [];
  if (ev.interests.interests) bits.push(`Interests (from the family): ${ev.interests.interests}`);
  if (ev.interests.favourites) bits.push(`Favourite toys and activities: ${ev.interests.favourites}`);
  if (ev.interests.skills) bits.push(`Things the family have mentioned they can do: ${ev.interests.skills}`);
  if (ev.interests.tags.length) bits.push(`Tags we have recorded: ${ev.interests.tags.join(', ')}`);
  return [
    `Child: ${name}${ev.child.age_months != null ? `, aged ${ev.child.age_months} months` : ''}.`,
    '',
    'What we are working on with them this term:',
    ev.open_next_steps.length
      ? ev.open_next_steps.slice(0, 8).map(n => `[${n.ref}] ${n.description}`).join('\n')
      : '(no next steps recorded)',
    '',
    bits.length ? bits.join('\n') : 'We have nothing recorded about what this child likes at home.',
    historyBlock(ev),
    '',
    `Write TWO OR THREE ideas the family could try at home to support the next steps above.`,
    'Each idea must be:',
    '  • one short title;',
    '  • "You need:" and then things almost every home already has — no buying anything, no printing;',
    '  • two to four numbered steps, each one a single plain sentence;',
    '  • a last line beginning "Tell us:" inviting the child to tell their key person about it.',
    'Ten to fifteen minutes each, doable on an ordinary weekday evening by a tired parent.',
    'Address the parent as "you" and the child by name. No jargon, no developmental theory, no praise for the nursery.',
    '',
    'Here are two existing Wren examples, purely so you match their tone and shape.',
    'Do NOT reuse their content — write ideas for THIS child\'s next steps:',
    ...HOME_IDEA_EXAMPLES.map(e => '  ' + e),
    '',
    'Cite the next-step reference in square brackets after the idea it supports.',
    `If the records genuinely do not support any specific idea for ${name}, reply with exactly: NOT ENOUGH EVIDENCE`,
  ].join('\n');
}

// ── Citation checking ────────────────────────────────────────────────────────
// Identical rules to b243's, and identical for a reason: during b243 testing the
// Ascent copied a non-reference out of the evidence block ("[not yet observed]")
// straight into a parent-facing PDF, and removing the brackets from the source
// line was not enough — the next run invented "[NOTE]" from a line with no
// brackets at all. A model shown a citation format will reach for it, so
// anything bracketed that does not resolve is removed.
const REF_RE = /\[([A-Z]+-\d+)\]/g;
const ANY_BRACKET_RE = /\[[^[\]\n]{1,60}\]/g;

function checkCitations(text, allowed) {
  const cited = [], invalid = [], stray = [];
  const cleaned = String(text || '').replace(ANY_BRACKET_RE, (m) => {
    const inner = m.slice(1, -1).trim();
    if (/^[A-Z]+-\d+$/.test(inner)) {
      if (allowed.has(inner)) { if (!cited.includes(inner)) cited.push(inner); return m; }
      invalid.push(inner);              // pointed at a record that does not exist
      return '';
    }
    stray.push(inner);                  // not a reference at all — cosmetic
    return '';
  }).replace(/\s+([.,;:])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
  return { text: cleaned, cited, invalid, stray };
}

// ═══════════════════════════════════════════════════════════════════════════
// Drafting
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Build the draft that becomes reports.content.
 *
 * Never throws for a model failure. If the Ascent is down the draft still comes
 * back — with the evidence, the headings, the next steps and the tracking data,
 * and an explicit note in each undrafted section telling the keyperson to write
 * it. The human gate is what makes the document valid either way, so an
 * inference box being busy must not stop a practitioner working.
 */
async function buildDraft(ev, opts = {}) {
  const allowed = new Set(Object.keys(ev.index));
  const name = ev.child.known_as || ev.child.first_name || 'Your child';
  // b359 — opt-in name redaction. null on every pre-b359 caller.
  const redactor = opts.redactor || null;
  const displayName = opts.displayName || name;
  const model = opts.model || ai.model(ROLE);
  const suff = sufficiency(ev);
  const errors = [];
  let host = null, generate = null;
  try {
    const sm = sovereign();
    host = sm.assertLocalHost(sm.OLLAMA);
    generate = sm.generate;
  } catch (e) { errors.push(`host: ${e.message}`); }

  const PROMPTS = { went_well: wentWellPrompt, working_on: workingOnPrompt, at_home: atHomePrompt };
  const WORDS   = { went_well: 480, working_on: 340, at_home: 620 };

  const sections = [];
  for (const def of SECTIONS) {
    const s = suff[def.key];

    // Not modelled at all: assembled from the records, verbatim.
    if (!def.modelled) {
      const body = def.key === 'next_steps'
        ? renderNextSteps(ev.open_next_steps, ev)
        : renderTracking(ev);
      sections.push({
        key: def.key, heading: def.heading, body,
        generated: false, sufficient: !!s.sufficient, evidence_summary: s,
        evidence: def.key === 'next_steps'
          ? ev.open_next_steps.map(n => n.ref)
          : ev.tracker.moved.slice(0, 20).map(m => m.ref),
        // A section with nothing real in it must not print. printableSections()
        // drops a placeholder the practitioner has not touched, so a parent never
        // receives "your key person will add…".
        placeholder: !s.sufficient,
      });
      continue;
    }

    // Modelled, but only when the bar in sufficiency() is met. A model that is
    // not asked cannot invent.
    if (!s.sufficient) {
      sections.push({
        key: def.key, heading: def.heading, body: gapText(def.key, ev),
        generated: false, sufficient: false, evidence: [], evidence_summary: s,
        placeholder: true,
      });
      continue;
    }

    let body = '', cited = [], invalid = [], stray = [], generated = false;
    try {
      if (!host || !generate) throw new Error('local model unavailable');

      /* ── b359: names out before the request, back in after it ─────────────
       * opts.redactor is a src/lib/name-redact.js redactor. Absent (every b246
       * path) this is the same two lines it always was; present, the prompt
       * that crosses the wire carries ⟪CHILD⟫ and the answer is rehydrated here,
       * on our own server, before anything else touches it.
       *
       * The leak scan runs on the REDACTED prompt, not on the answer: the point
       * is to prove what was SENT, and opts.onPrompt hands both to the caller so
       * the claim ends up on a row somebody can read back. */
      let prompt = PROMPTS[def.key](ev);
      let leaked = [];
      if (redactor) {
        prompt = redactor.redact(prompt);
        leaked = redactor.leaks(prompt);
        if (leaked.length) {
          // Fail the SECTION, not the draft. A name that survived redaction must
          // not be sent, and the practitioner still gets every other section.
          throw new Error(`redaction incomplete (${leaked.length} name(s) still in the prompt) — nothing was sent`);
        }
      }
      if (typeof opts.onPrompt === 'function') {
        try { opts.onPrompt(def.key, prompt, leaked); } catch (_) { /* logging must never fail a draft */ }
      }

      let raw = await generate({
        model, system: SYSTEM, prompt,
        temperature: 0.2, numPredict: WORDS[def.key], timeoutMs: TIMEOUT_MS,
      });
      if (redactor) raw = redactor.rehydrate(raw, displayName);
      if (/NOT ENOUGH EVIDENCE/i.test(raw)) {
        body = gapText(def.key, ev);
        sections.push({ key: def.key, heading: def.heading, body, generated: false,
                        sufficient: false, evidence: [], evidence_summary: s, placeholder: true,
                        model_declined: true });
        continue;
      }
      const checked = checkCitations(raw, allowed);
      body = checked.text; cited = checked.cited; invalid = checked.invalid; stray = checked.stray;
      generated = true;
      if (!body) throw new Error('model returned nothing usable');
    } catch (e) {
      errors.push(`${def.key}: ${e.message}`);
      body = `The automatic draft for this section could not be produced (${e.message}). `
           + `${name}'s key person will write it. The records gathered for it are listed with this draft.`;
      generated = false;
    }
    sections.push({
      key: def.key, heading: def.heading, body, generated,
      sufficient: true, evidence: cited, invalid_citations: invalid, stray_markers: stray,
      evidence_summary: s,
      // A failed model call leaves a note addressed to the practitioner, which
      // must never print for a parent either.
      placeholder: !generated,
    });
  }

  return {
    kind: 'termly_update',
    version: 1,
    status_note: 'Draft — not yet reviewed by a practitioner.',
    cycle: {
      key: ev.cycle.key, label: ev.cycle.label, name: ev.cycle.name,
      academic_year: ev.cycle.academic_year,
      term_start: ev.cycle.term_start, term_end: ev.cycle.term_end,
      due_on: ev.cycle.due_on, overdue_on: ev.cycle.overdue_on,
      source: 'school_terms (Ealing)',
    },
    windows: ev.windows,
    child: ev.child,
    keyperson: ev.keyperson,
    sections,
    // The structured half of section 3 — what the card picker writes back to.
    next_steps: {
      items: ev.open_next_steps.map(n => ({
        next_step_id: n.id, description: n.description, status: n.status,
        area: n.area, area_label: n.area_label, due_by: n.due_by,
        resource_card_slug: n.resource_card_slug, resource_card_title: n.resource_card_title,
        library_activity_id: n.library_activity_id, library_activity_name: n.library_activity_name,
      })),
    },
    tracking: {
      framework: ev.tracker.framework,
      total: ev.tracker.total,
      by_status: ev.tracker.by_status,
      areas: ev.tracker.areas,
      moved: ev.tracker.moved.slice(0, 40),
    },
    /* b291 — the recorded range per area and how secure in it, stored on the
     * report row alongside the tracker counts so the practitioner reviewing the
     * draft (and anyone reading it back later) can see the judgement behind
     * section 5, not just the prose it produced. */
    ranges: ev.ranges && ev.ranges.areas.length ? {
      framework: ev.ranges.framework,
      rated: ev.ranges.rated,
      unrated: ev.ranges.unrated,
      areas: ev.ranges.areas,
    } : null,
    previous: ev.previous ? { id: ev.previous.id, cycle_key: ev.previous.cycle_key,
                              cycle_label: ev.previous.cycle_label, sent_at: ev.previous.sent_at } : null,
    evidence_index: ev.index,
    counts: ev.counts,
    sufficiency: suff,
    model: {
      host: host || null, model: host ? model : null,
      generated_at: new Date().toISOString(),
      errors: errors.length ? errors : null,
      note: host
        ? 'Drafted on the setting\'s own hardware. No child data left the local network.'
        : 'The local model was unavailable — the written sections are for the key person to write.',
      // b359 — whether names were taken out of the prompt for this draft. Stored
      // so the posture of a document is readable from the document, not inferred
      // from which build produced it.
      redacted: !!redactor,
      redaction_note: redactor
        ? 'Children\'s and staff names were replaced with placeholders before the model was asked, and put back afterwards on this server.'
        : null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Printing
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The parent-facing sections, in Toby's order, for the PDF. Everything the
 * practitioner uses to work — evidence refs, sufficiency counts, invalid
 * citations — is stripped: a parent gets prose, not our working.
 *
 * A placeholder the practitioner has not edited is DROPPED rather than printed.
 * A family should never receive a document that says "your key person will add
 * something here"; either there is a section or there is not.
 */
/**
 * b277 (2026-09-04): which section keys this document has, and in what order.
 *
 * b246 documents have exactly the five SECTION_KEYS and no `section_order`, so
 * they take the first branch and behave byte-for-byte as before. A b277
 * watcher-assembled document carries its own list (practitioner_update,
 * term_plan, next_steps, at_home, tracking) and both printableSections() and
 * sendProblems() read it from here rather than assuming the five.
 *
 * Assuming the five is what would have broken: sendProblems() iterates SECTIONS
 * and counts sections that hold text, so against a document whose keys it did
 * not recognise it would have found none, concluded "every section is empty" and
 * refused to send a perfectly complete update.
 */
function sectionOrderOf(content) {
  const declared = content && content.section_order;
  if (Array.isArray(declared) && declared.length && declared.every(k => typeof k === 'string')) {
    return declared.slice();
  }
  return SECTION_KEYS.slice();
}

/** The heading a key belongs to, for whichever document shape this is. */
function headingFor(content, key, fallback) {
  const secs = Array.isArray(content && content.sections) ? content.sections : [];
  const hit = secs.find(s => s && s.key === key);
  return (hit && hit.heading) || fallback || key;
}

function printableSections(content) {
  const secs = Array.isArray(content && content.sections) ? content.sections : [];
  const order = new Map(sectionOrderOf(content).map((k, i) => [k, i]));
  const out = secs
    .slice()
    .sort((a, b) => (order.has(a.key) ? order.get(a.key) : 99) - (order.has(b.key) ? order.get(b.key) : 99))
    .filter(s => s && String(s.body || '').trim())
    .filter(s => !(s.placeholder && !s.edited_by_practitioner))
    .map(s => ({
      heading: s.heading || null,
      body: String(s.body).replace(REF_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:])/g, '$1').trim(),
    }));

  const approved = content && content.approved_by;
  if (approved && String(approved.name || '').trim()) {
    const at = (content.sent && content.sent.at) || approved.at || new Date();
    out.push({
      heading: 'Reviewed and approved by',
      body: [
        `${approved.name}${approved.role ? ', ' + approved.role : ''}`,
        longDate(at),
        '',
        content.cycle && content.cycle.label
          ? `Progress update for ${content.cycle.label}. Our term dates follow Ealing's school calendar.`
          : '',
      ].filter(Boolean).join('\n'),
    });
  }
  return out;
}

/**
 * What is stopping this update being sent? Empty array = ready.
 *
 * THE THREE RULES, and why "empty" is not one of them:
 *
 *  1. A non-empty section the practitioner has not touched, which still holds
 *     the drafter's "we have not recorded enough yet" text, BLOCKS. Without this
 *     an update whose model call failed would go out with five paragraphs of
 *     "your key person will add…" over somebody's signature.
 *
 *  2. An EMPTY section does not block, it is simply left out — printableSections()
 *     drops it. This is deliberate and it is the escape hatch rule 1 needs: a
 *     child with no tracker data yet has nothing true to say in section 5, and a
 *     gate that demanded words there while also refusing the placeholder would be
 *     a gate with no way through. Clearing a section is a decision a practitioner
 *     is allowed to make.
 *
 *  3. …but not for ALL of them. An update with every section cleared is a PDF
 *     with a child's name and nothing else, and sending one is never what
 *     somebody meant to do.
 *
 * Plus the signature, which is the whole point of the review gate.
 */
function sendProblems(content) {
  const problems = [];
  const secs = Array.isArray(content && content.sections) ? content.sections : [];
  const byKey = Object.fromEntries(secs.map(s => [s.key, s]));
  // b277 — the keys THIS document has, not the five b246 assumes. See
  // sectionOrderOf() above for why the difference matters.
  const defByKey = Object.fromEntries(SECTIONS.map(d => [d.key, d]));
  const defs = sectionOrderOf(content).map(k => defByKey[k]
    || { key: k, heading: headingFor(content, k, k) });
  let nonEmpty = 0;
  for (const def of defs) {
    const s = byKey[def.key];
    const body = String((s && s.body) || '').trim();
    if (!body) continue;                                   // rule 2 — left out
    nonEmpty++;
    if (s.placeholder && !s.edited_by_practitioner) {       // rule 1 — blocks
      problems.push(`"${def.heading}" has not been written yet — it still says we do not have enough `
        + 'recorded. Either write it, or clear the box and it will be left out of the update.');
    }
  }
  // Rule 3 is about the EMPTY document, so it counts sections that hold text —
  // not sections that pass rule 1. Counting the latter would print "every section
  // is empty" underneath five complaints that they are not, which reads as a bug
  // to the person trying to fix them.
  if (!nonEmpty) {
    problems.push('Every section is empty, so this update would reach the family with nothing in it. '
      + 'Write at least one section before sending.');
  }
  const approved = (content && content.approved_by) || {};
  if (!String(approved.name || '').trim()) problems.push('Add your name — a parent needs to know who wrote this.');
  if (!String(approved.role || '').trim()) problems.push('Add your role.');
  return problems;
}

module.exports = {
  SECTIONS, SECTION_KEYS, AREAS, AREA_BY_KEY, TRACKER_ORDER, TRACKER_LABEL,
  editionFamily, isEyfsEdition, roleLabel, areaKey,
  ymd, longDate, ageInMonths,
  gatherEvidence, sufficiency, gapText, buildDraft,
  renderNextSteps, renderTracking,
  checkCitations, printableSections, sendProblems,
  sectionOrderOf, headingFor,   // b277
  HOME_IDEA_EXAMPLES,
};
