'use strict';
/* parents_planning_live — the one switch that lets the parents' /welcome/planning page show the LIVE plans.
 *
 * the office manager, 27 Oct 2026: staff now see the planning through public/js/wren-plan-view.js; parents see the same layout
 * but today from a frozen "Summer 2" snapshot baked into editions/parents/welcome/planning.html.
 *
 * The switch is one ladn.settings row, the same pattern as src/lib/fledge-switch.js:
 *     key = 'parents_planning_live', value = 'true'   → parents see the live PUBLISHED plans
 *     absent, or any other value                      → OFF (the default): today's frozen page, unchanged
 *
 * Read server-side, short-cached (30 s), and it fails OFF — a DB error is "off", never "on".
 *
 * What a parent is ever sent (buildLive):
 *   • PUBLISHED half-terms only. A draft, or a half-term with no plan, is not in the payload at all — not as a
 *     tab, not as a name, not as a theme — so there is nothing for a parent to learn about it. There is no
 *     parameter that selects a half-term or a room, so there is nothing to tamper with either.
 *   • Parent-visible plan content only: theme, dates, learning intentions, books, songs, events, the activity
 *     cards and each day's title / focus / adult role (all of which the frozen page already shows).
 *   • NEVER the staff-only fields: resources and resource-card names, week notes, staff notes, the
 *     end-of-half-term evaluation, carry-forward, plan source, ids of plans/activities.
 */
const TTL_MS = 30 * 1000;
let _cache = { at: 0, on: false };

function _parse(v) { return /^(true|1|on|yes)$/i.test(String(v == null ? '' : v).trim()); }
function _pool(db) {
  if (db && typeof db.query === 'function') return db;
  return require('../db/pool').getPool();
}

/** true only when ladn.settings.parents_planning_live says so. Never throws (fails OFF). */
async function isParentsPlanningLive(db) {
  const now = Date.now();
  if (now - _cache.at < TTL_MS) return _cache.on;
  let on = false;
  try {
    const { rows } = await _pool(db).query(`SELECT value FROM settings WHERE key = 'parents_planning_live' LIMIT 1`);
    on = !!(rows[0] && _parse(rows[0].value));
  } catch (_) { on = false; }
  _cache = { at: now, on };
  return on;
}
function clearParentsPlanningCache() { _cache = { at: 0, on: false }; }

const TPV = require('./term-plan-view');
const CAL = require('./school-calendar');
const planStatus = require('./plan-status');

/** The plan view with every staff-only field removed. An allow-list, not a delete-list. */
function parentSafeView(v) {
  const days = d => (d || []).map(x => ({
    weekday: x.weekday, weekday_name: x.weekday_name, category: x.category, title: x.title, role_of_adult: x.role_of_adult,
    description: x.description, intention: x.intention,   // ps-autumn2-20261030 — planning text, no child data
  }));
  return {
    room_id: v.room_id, room_name: v.room_name, term_name: v.term_name, academic_year: v.academic_year,
    starts: v.starts, ends: v.ends, theme: v.theme, status: 'published', unplanned: false,
    overview: v.overview || null,   // ps-autumn2-20261030 — strapline, ongoing points, tuff trays
    intentions: v.intentions, key_books: v.key_books, songs: v.songs, events: v.events,
    focus_activities: (v.focus_activities || []).map(c => ({
      title: c.title, intent: c.intent, implementation: c.implementation, impact: c.impact, adult_role: c.adult_role })),
    has_days: v.has_days,
    bands: (v.bands || []).map(b => ({
      label: b.label, week_nos: b.week_nos, week_commencing: b.week_commencing, days: days(b.days),
      activities: (b.activities || []).map(a => ({ title: a.title, description: a.description })),
    })),
  };
}

/**
 * @param {object} db
 * @param {number[]} myRoomIds  the rooms this parent's own children are in
 * @returns {{live:true, today:string, academic_year:string, rooms:[...]}}
 */
async function buildLive(db, myRoomIds) {
  const planning = require('../routes/planning');
  const today = CAL.todayYmd();
  const ay = CAL.academicYearOf(today);
  const cal = await CAL.loadCalendar(db, ay);
  const hts = cal.terms.filter(t => t.academic_year === ay);
  const res = CAL.resolveDay(today, cal.terms, cal.breaks) || {};
  const nowId = res.half_term && res.half_term.id;
  const nextId = !nowId && res.next_half_term && res.next_half_term.id;
  const prevId = res.previous_half_term && res.previous_half_term.id;
  const { rows: roomRows } = await db.query(`SELECT id, name FROM rooms ORDER BY id`);
  const mine = new Set((myRoomIds || []).map(Number));

  const rooms = [];
  for (const r of roomRows) {
    const out = [];
    for (const ht of hts) {
      const term = { kind: 'half_term', id: ht.id, name: ht.name, academic_year: ht.academic_year, term: ht.term, half: ht.half,
                     year: parseInt(ht.academic_year.slice(0, 4), 10), start_date: ht.start_date, end_date: ht.end_date };
      const bundle = await planning.loadPlanBundle(db, r.id, term);
      const plan = bundle.plan;
      // the one gate: published, and not the importer's "not planned" placeholder
      if (!plan || !planStatus.isPublishedRow(plan) || TPV.isUnplanned(plan)) continue;
      const view = TPV.planView(plan, { weeks: bundle.weeks, days: bundle.days, events: bundle.events, term, room: r });
      out.push({ id: ht.id, name: ht.name, start_date: ht.start_date, end_date: ht.end_date,
                 now: ht.id === nowId, next: ht.id === nextId, view: parentSafeView(view) });
    }
    if (!out.length && !mine.has(r.id)) continue;
    // which tab opens: the half-term we are in, else the next, else the one just gone, else the first
    let open = out.findIndex(h => h.now);
    if (open < 0) open = out.findIndex(h => h.next);
    if (open < 0) open = out.findIndex(h => h.id === prevId);
    if (open < 0) open = Math.max(0, out.length - 1);
    rooms.push({ id: r.id, name: r.name, mine: mine.has(r.id), open, half_terms: out });
  }
  rooms.sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || a.id - b.id);    // the child's own room first
  return { live: true, today, academic_year: ay, rooms };
}

module.exports = { isParentsPlanningLive, clearParentsPlanningCache, buildLive, parentSafeView };
