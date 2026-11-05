'use strict';
/**
 * term-plan-view.js — b302 (2026-09-10)
 *
 * ONE reader for a half-term plan, used by every portal.
 *
 * ── THE DEFECT THIS EXISTS TO END ───────────────────────────────────────────
 * Toby, 2026-09-10: "the planning on EY and admin looks weird. I want the exact
 * planning I uploaded put on there — the intentions, the activities, everything.
 * Just like how it is on the parents app."
 *
 * ladn.term_plans can hold its learning intentions in either of two columns, and
 * which one is filled depends on how the plan got there:
 *
 *   learning_intentions  text[]   ← the b245/b276/b284 imports of Toby's own
 *                                   paper planning. A flat list of sentences.
 *   intentions           jsonb    ← a manager ticking framework statements on
 *                                   the termly-plan screen. { area: [ {…} ] }.
 *
 * Three portals then read three different fields. The parents surfaces read the
 * flat array and render a complete plan; Roost and EY read the jsonb object and
 * rendered an empty "Learning intentions" section against Autumn 1 pre-school —
 * a plan holding a theme, five intentions, six books, eight songs and
 * twenty-four planned activities. Nothing was missing from the database. Only
 * the reader was wrong, in two of the three places it was written.
 *
 * So the resolution lives here, once, and everything reads through it.
 *
 * ── NOT A MIGRATION ─────────────────────────────────────────────────────────
 * Deliberately NOT fixed by copying learning_intentions into intentions. The
 * flat array is what the parents app and the public curriculum page depend on,
 * it is the view that works, and it is the shape the upload genuinely has:
 * sentences the setting wrote, not framework statement ids. Grouping them into
 * areas would mean inventing an area for each, which is the sort of tidying that
 * turns real content into a guess. Both columns are read; whichever holds the
 * plan wins; neither is written by this module.
 *
 * ── PRECEDENCE ──────────────────────────────────────────────────────────────
 * The flat array wins when both are populated. That is the same precedence
 * src/lib/termly-planning.js has used since b277 for the parent-facing termly
 * update, and changing it here would make the parents document and the staff
 * screen disagree — which is the whole complaint.
 */

// ── shapes ───────────────────────────────────────────────────────────────────
const arr = v => (Array.isArray(v) ? v.map(x => String(x == null ? '' : x).trim()).filter(Boolean) : []);

const str = v => String(v == null ? '' : v).trim();

/** jsonb comes back as an object from pg, but as text from some drivers/views. */
function asJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * The intentions as the termly-plan SCREEN groups them: { area: [ {text, …} ] }.
 * Empty object when the plan was imported flat — the caller shows the flat list
 * instead, it does not invent areas.
 */
function groupedIntentions(row) {
  const obj = asJson(row && row.intentions);
  if (!obj || Array.isArray(obj) || typeof obj !== 'object') return {};
  const out = {};
  for (const [area, list] of Object.entries(obj)) {
    if (!Array.isArray(list)) continue;
    const picked = list.map(it => {
      if (typeof it === 'string') return { text: str(it), statement_id: null, code: null, sub_area: null, area };
      if (it && typeof it === 'object') {
        return {
          statement_id: it.statement_id != null ? parseInt(it.statement_id, 10) : null,
          code: it.code ? String(it.code) : null,
          // statement_text is what some older rows carry; src/lib/plan-pdf.js
          // has always accepted it and must not lose rows by reading through here.
          text: str(it.text || it.statement_text),
          sub_area: it.sub_area ? String(it.sub_area) : null,
          area,
        };
      }
      return null;
    }).filter(it => it && it.text);
    if (picked.length) out[area] = picked;
  }
  return out;
}

/**
 * The intentions as a flat list of sentences — what every read-only view shows
 * and what the parents app has always shown.
 */
function intentionList(row) {
  if (!row) return [];
  const flat = arr(row.learning_intentions);
  if (flat.length) return flat;
  const j = asJson(row.intentions);
  if (!j) return [];
  if (Array.isArray(j)) return arr(j);
  if (typeof j !== 'object') return [];
  // { psed: [ {text} ] } or b181's { psed: 'text' }. Values only — the area keys
  // are internal and a parent has no use for "psed:".
  const out = [];
  for (const v of Object.values(j)) {
    if (Array.isArray(v)) {
      for (const it of v) {
        const t = (it && typeof it === 'object') ? str(it.text) : str(it);
        if (t) out.push(t);
      }
    } else {
      const t = (v && typeof v === 'object') ? str(v.text) : str(v);
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * Where the intentions on screen came from. The editors need this: an imported
 * list is edited as free text, a picked list is edited by ticking statements,
 * and showing the wrong control against the wrong data is how b302 started.
 *
 *   'picked'   — a manager ticked framework statements (intentions jsonb)
 *   'imported' — the setting's own uploaded plan (learning_intentions text[])
 *   'none'     — nobody has written any yet
 */
function intentionSource(row) {
  if (!row) return 'none';
  if (arr(row.learning_intentions).length) return 'imported';
  if (Object.keys(groupedIntentions(row)).length) return 'picked';
  return 'none';
}

/** term_plans.overview (jsonb) → { summary, ongoing[], tuff_trays[{label,title,items[]}] }, or null. */
function overviewOf(row) {
  const o = asJson(row && row.overview);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const list = v => (Array.isArray(v) ? v : []).map(x => str(x)).filter(Boolean);
  const trays = (Array.isArray(o.tuff_trays) ? o.tuff_trays : [])
    .map(t => t && ({ label: str(t.label) || null, title: str(t.title) || null, items: list(t.items) }))
    .filter(t => t && (t.title || t.items.length));
  const out = { summary: str(o.summary) || null, ongoing: list(o.ongoing), tuff_trays: trays };
  return (out.summary || out.ongoing.length || out.tuff_trays.length) ? out : null;
}

/** The plan's own events column — a jsonb list, separate from the calendar. */
function eventList(row) {
  const j = asJson(row && row.events);
  if (!Array.isArray(j)) return [];
  return j.map(e => {
    if (typeof e === 'string') return { title: str(e), date: null, location: null };
    if (e && typeof e === 'object') {
      const title = str(e.title || e.name);
      return title ? { title, date: e.date || e.on || e.event_date || null, location: e.location || null } : null;
    }
    return null;
  }).filter(Boolean);
}

/** True when the row exists but holds no plan — b276's "not planned" marker. */
function isUnplanned(row) {
  if (!row) return true;
  if (/^not-planned/i.test(str(row.plan_source))) return true;
  const hasAnything = str(row.theme)
    || arr(row.key_books).length || arr(row.songs).length || intentionList(row).length;
  return !hasAnything;
}

// ── the view ─────────────────────────────────────────────────────────────────

const ymd = d => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  // pg hands back DATE as a local-midnight JS Date; local getters, never
  // toISOString(), or a UK date slips to the day before.
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** "Week 3 · w/c 5 Oct" — a label a practitioner reads, not a row number. */
function weekLabel(weekNo, commencing) {
  const d = ymd(commencing);
  if (!d) return `Week ${weekNo}`;
  const dt = new Date(d + 'T12:00:00');
  if (isNaN(dt)) return `Week ${weekNo}`;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `Week ${weekNo} · w/c ${dt.getDate()} ${MON[dt.getMonth()]}`;
}

function shapeActivity(a, extra) {
  if (!a) return null;
  const name = str(a.name);
  if (!name && !str(a.title)) return null;
  return Object.assign({
    id: a.id != null ? a.id : null,
    title: name || str(a.title),
    description: str(a.description) || null,
    category: str(a.category) || null,
    eyfs_areas: arr(a.eyfs_areas),
    age_range: str(a.age_range) || null,
    resources_needed: str(a.resources_needed) || null,
    missing: !!a.missing,
  }, extra || {});
}

/**
 * Everything one half-term's plan holds, in the order the parents app presents
 * it: theme, intentions, books, songs, events, then the activities week by week.
 *
 * @param {object|null} row     the term_plans row (raw)
 * @param {object} ctx
 *   weeks  – hydrated termly_plan_weeks rows (as GET /termly/plan builds them)
 *   days   – hydrated termly_plan_days rows (the baby room's weekday rhythm)
 *   events – calendar rows the plan ticked: {id,title,event_date,location}
 *   term   – the resolved half-term {name,start_date,end_date,…}
 *   room   – {id,name}
 */
/* ── b521: the A4 planning SHEET, in the format Kat wrote ─────────────────────
 * Toby, 2026-10-20: "it doesn't look like the most recent pre-school planning I
 * gave you from Kat ... I wanted it in that exact format. It was quite pretty, A4,
 * with light autumn colours."
 *
 * Kat's sheet is a stack of coloured activity cards, each headed with the activity
 * name and carrying four labelled lines: Intent, Implementation, Impact, Adult
 * Role. term_plans.focus_activities (b521) is where those live.
 *
 * TWO SOURCES, one shape, so the sheet is never blank:
 *   'typed'   — someone filled focus_activities in. Printed as written.
 *   'grid'    — they have not yet, so one card per provision-grid area, built from
 *               the plan text b404 already loaded from the same document. The
 *               Implementation line is the real grid text; the other three lines
 *               are left EMPTY rather than invented, and the view says source:
 *               'grid' so the screen can offer "write this up properly".
 * Nothing here writes. A plan with neither returns [] and the sheet says so.
 *
 * Empty-string fields are kept out rather than rendered as "Intent:" with nothing
 * after it — a labelled blank line reads as a gap in the plan.
 */
const FOCUS_FIELDS = ['intent', 'implementation', 'impact', 'adult_role'];
// Older/looser spellings seen in hand-written JSON and in the source document.
const FOCUS_ALIAS = {
  adultrole: 'adult_role', 'adult role': 'adult_role', role_of_adult: 'adult_role',
  role: 'adult_role', how: 'implementation', why: 'intent', outcome: 'impact',
};

function shapeFocusCard(a, i) {
  if (!a || typeof a !== 'object') return null;
  const card = { title: '', colour: str(a.colour) || null };
  for (const [k, v] of Object.entries(a)) {
    const key = FOCUS_ALIAS[String(k).toLowerCase()] || String(k).toLowerCase();
    if (key === 'title' || key === 'name' || key === 'activity') card.title = card.title || str(v);
    else if (FOCUS_FIELDS.includes(key)) card[key] = str(v);
  }
  const hasBody = FOCUS_FIELDS.some(f => card[f]);
  if (!card.title && !hasBody) return null;
  if (!card.title) card.title = 'Activity ' + (i + 1);
  for (const f of FOCUS_FIELDS) if (!card[f]) delete card[f];
  return card;
}

/** The cards someone typed. [] when the column is empty or not an array. */
function typedFocusActivities(row) {
  if (!row) return [];
  const raw = asJson(row.focus_activities);
  if (!Array.isArray(raw)) return [];
  return raw.map(shapeFocusCard).filter(Boolean);
}

/** One card per provision-grid area, so an existing plan prints in Kat's format. */
function gridFocusActivities(row) {
  if (!row) return [];
  const grid = asJson(row.provision_grid);
  if (!grid || !Array.isArray(grid.blocks)) return [];
  const labels = new Map();
  for (const a of (Array.isArray(grid.areas) ? grid.areas : [])) {
    if (a && a.slug) labels.set(String(a.slug), str(a.label) || String(a.slug));
  }
  const out = [];
  for (const b of grid.blocks) {
    if (!b || !b.areas || typeof b.areas !== 'object') continue;
    const weeks = Array.isArray(b.weeks) ? b.weeks.filter(w => Number.isFinite(Number(w))) : [];
    // "Weeks 1–2" is how the source document labels its blocks.
    const when = weeks.length > 1 ? `Weeks ${weeks[0]}–${weeks[weeks.length - 1]}`
               : weeks.length === 1 ? `Week ${weeks[0]}` : '';
    for (const [slug, cell] of Object.entries(b.areas)) {
      if (!cell || typeof cell !== 'object') continue;
      const plan = str(cell.plan);
      const book = str(cell.book);
      if (!plan && !book) continue;
      const area = labels.get(slug) || slug.replace(/_/g, ' ');
      out.push({
        title: when ? `${area} · ${when}` : area,
        implementation: [plan, book ? `Book: ${book}` : ''].filter(Boolean).join(' '),
        colour: null,
        _area: slug,
      });
    }
  }
  return out;
}

/**
 * The sheet: { source: 'typed' | 'grid' | 'none', cards: [...] }.
 * Typed cards win — a grid-derived card is a stand-in for one nobody wrote yet.
 */
function focusSheet(row) {
  const typed = typedFocusActivities(row);
  if (typed.length) return { source: 'typed', cards: typed };
  // ps-autumn2-20261030: a room that loaded its own overview sheet HAS written the plan, so
  // the yearly grid's stand-in cards (written months earlier) would only contradict it.
  if (overviewOf(row)) return { source: 'none', cards: [] };
  const grid = gridFocusActivities(row);
  if (grid.length) return { source: 'grid', cards: grid };
  return { source: 'none', cards: [] };
}

function planView(row, ctx) {
  const c = ctx || {};
  const weeksIn = Array.isArray(c.weeks) ? c.weeks : [];
  const daysIn = Array.isArray(c.days) ? c.days : [];
  const term = c.term || null;
  const room = c.room || {};

  const view = {
    plan_id: row ? row.id : null,
    room_id: row ? row.room_id : (room.id != null ? room.id : null),
    room_name: str(room.name) || null,
    term_name: row ? str(row.term_name) : (term ? str(term.name) : null),
    academic_year: row ? str(row.academic_year) : (term ? str(term.academic_year) : null),
    starts: term ? ymd(term.start_date) : null,
    ends: term ? ymd(term.end_date) : null,
    theme: row ? (str(row.theme) || null) : null,
    intentions: row ? intentionList(row) : [],
    intentions_grouped: row ? groupedIntentions(row) : {},
    intentions_source: intentionSource(row),
    key_books: row ? arr(row.key_books) : [],
    songs: row ? arr(row.songs) : [],
    carry_forward: row ? (str(row.carry_forward) || null) : null,
    evaluation: row ? (str(row.evaluation) || null) : null,
    plan_source: row ? (row.plan_source || null) : null,
    status: row ? (row.status || null) : null,
    unplanned: isUnplanned(row),
    // ps-autumn2-20261030 — term_plans.overview: the overview sheet's strapline, its
    // "throughout the half-term" points and the tuff trays. Parent-safe (planning text).
    overview: overviewOf(row),
    // b521 — the A4 planning sheet in Kat's format. One reader, every portal.
    focus_activities: [],
    focus_source: 'none',
    events: [],
    weeks: [],
    activities: [],
    activity_count: 0,
    has_days: false,
  };

  // b521 — the sheet, resolved once here so Roost, EY, the parents view and the
  // PDF all print the same cards from the same row.
  const sheet = focusSheet(row);
  view.focus_activities = sheet.cards;
  view.focus_source = sheet.source;

  // Events: the ticked calendar rows first (they carry a real date), then any
  // the plan's own jsonb column holds, skipping titles already listed.
  const seenEvent = new Set();
  for (const e of (Array.isArray(c.events) ? c.events : [])) {
    const title = str(e.title);
    if (!title) continue;
    seenEvent.add(title.toLowerCase());
    view.events.push({ title, date: ymd(e.event_date), location: str(e.location) || null });
  }
  for (const e of eventList(row)) {
    if (seenEvent.has(e.title.toLowerCase())) continue;
    seenEvent.add(e.title.toLowerCase());
    view.events.push({ title: e.title, date: ymd(e.date), location: e.location });
  }
  // ps-autumn2-20261030: calendar rows and the plan's own rows interleave — list them by date.
  view.events.sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));

  // Weeks, each carrying its own activities, continuous-provision cards and —
  // for the baby room — its five named days.
  const daysByWeek = new Map();
  for (const d of daysIn) {
    if (!daysByWeek.has(d.week_no)) daysByWeek.set(d.week_no, []);
    daysByWeek.get(d.week_no).push(d);
  }
  view.has_days = daysByWeek.size > 0;

  const byWeekNo = new Map();
  for (const w of weeksIn) {
    const wk = byWeekNo.get(w.week_no) || {
      week_no: w.week_no,
      week_commencing: ymd(w.week_commencing),
      label: weekLabel(w.week_no, w.week_commencing),
      notes: str(w.notes) || null,
      activities: [],
      resource_cards: [],
      days: [],
    };
    for (const a of (Array.isArray(w.activities) ? w.activities : [])) {
      const s = shapeActivity(a);
      if (s) wk.activities.push(s);
    }
    for (const rc of (Array.isArray(w.resource_cards) ? w.resource_cards : [])) {
      if (rc) wk.resource_cards.push(rc);
    }
    byWeekNo.set(w.week_no, wk);
  }
  for (const [weekNo, ds] of daysByWeek) {
    const wk = byWeekNo.get(weekNo) || {
      week_no: weekNo, week_commencing: null, label: weekLabel(weekNo, null),
      notes: null, activities: [], resource_cards: [], days: [],
    };
    for (const d of ds.sort((a, b) => (a.weekday || 0) - (b.weekday || 0))) {
      wk.days.push({
        weekday: d.weekday,
        weekday_name: d.weekday_name || null,
        category: str(d.category) || null,
        category_slug: d.category_slug || null,
        title: str(d.title) || null,
        // role_of_adult is what the parents planning page prints as "Adult role".
        role_of_adult: str(d.role_of_adult) || null,
        // ps-autumn2-20261030 — the 6-week overview's two lines under each day:
        // what we do, and the "To develop …" learning intention. Parent-safe (planning text).
        description: str(d.description) || null,
        intention: str(d.intention) || null,
        activities: (Array.isArray(d.activities) ? d.activities : []).map(a => shapeActivity(a)).filter(Boolean),
        resource_cards: Array.isArray(d.resource_cards) ? d.resource_cards : [],
      });
    }
    byWeekNo.set(weekNo, wk);
  }
  view.weeks = [...byWeekNo.values()].sort((a, b) => a.week_no - b.week_no);

  // ── A WEEK IS NOT SHOWN TWICE ───────────────────────────────────────────────
  // termly_plan_weeks.activity_ids for the baby room is the UNION of that week's
  // five termly_plan_days.activity_ids — the same five activities recorded both
  // ways. Rendering both is how the screens ended up "looking weird": every
  // activity appeared as a named weekday AND again as a loose card underneath.
  // So each week also carries the activities its days do NOT already cover, and
  // that is what a view renders alongside the day rhythm.
  for (const wk of view.weeks) {
    const inDays = new Set();
    for (const d of wk.days) for (const a of d.activities) if (a.id != null) inDays.add(a.id);
    wk.activities_extra = wk.days.length
      ? wk.activities.filter(a => a.id == null || !inDays.has(a.id))
      : wk.activities.slice();
  }

  // ── CONSECUTIVE WEEKS THAT PLAN THE SAME THING ARE ONE BAND ─────────────────
  // Toby's yearly plan is written in two-week bands ("Autumn 1 weeks 1-2"), and
  // b276 faithfully wrote the same four activities against both weeks of each
  // band. Printing "Week 1" and "Week 2" with identical contents underneath each
  // is true and unreadable. Consecutive weeks whose planned content is identical
  // collapse into one band that says so; a week that differs stands alone. The
  // per-week rows above are untouched — this is a second view of them.
  const sig = wk => JSON.stringify([
    wk.days.map(d => [d.weekday, d.title, d.role_of_adult, d.description, d.intention, d.activities.map(a => a.id)]),
    wk.activities_extra.map(a => a.id != null ? a.id : a.title),
  ]);
  view.bands = [];
  for (const wk of view.weeks) {
    if (!wk.days.length && !wk.activities_extra.length) continue;   // an empty week says nothing
    const last = view.bands[view.bands.length - 1];
    if (last && last._sig === sig(wk) && last.week_nos[last.week_nos.length - 1] === wk.week_no - 1) {
      last.week_nos.push(wk.week_no);
      continue;
    }
    view.bands.push({
      _sig: sig(wk),
      week_nos: [wk.week_no],
      week_commencing: wk.week_commencing,
      days: wk.days,
      activities: wk.activities_extra,
      notes: wk.notes,
    });
  }
  for (const b of view.bands) {
    const a = b.week_nos[0], z = b.week_nos[b.week_nos.length - 1];
    const base = a === z ? weekLabel(a, b.week_commencing) : `Weeks ${a}–${z}`;
    b.label = (a === z) ? base
      : base + (b.week_commencing ? ' · from w/c ' + weekLabel(a, b.week_commencing).split('w/c ')[1] : '');
    delete b._sig;
  }

  // The flat activity list: every planned activity across the half-term, in week
  // order, deduplicated by title because the same provision repeats week to week
  // and a parent (or a practitioner reading the plan back) wants the topic once.
  const seenAct = new Set();
  for (const wk of view.weeks) {
    const fromDays = wk.days.flatMap(d => d.activities.map(a => Object.assign({}, a, {
      day: d.weekday_name || null, category: a.category || d.category_slug || null,
    })));
    for (const a of wk.activities_extra.concat(fromDays)) {
      const key = a.title.toLowerCase();
      if (seenAct.has(key)) continue;
      seenAct.add(key);
      view.activities.push(Object.assign({}, a, {
        week_no: wk.week_no, week_label: wk.label, week_commencing: wk.week_commencing,
      }));
    }
  }
  view.activity_count = view.activities.length;

  return view;
}

module.exports = {
  arr, asJson,
  groupedIntentions, intentionList, intentionSource, eventList, isUnplanned,
  planView, weekLabel, ymd,
  // b521 — the A4 planning sheet (Kat's format)
  focusSheet, typedFocusActivities, gridFocusActivities, shapeFocusCard, FOCUS_FIELDS,
};
