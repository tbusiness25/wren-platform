'use strict';
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
/**
 * calendar-layers.js — b518 (2026-10-20)
 *
 * ONE calendar for the setting, in three layers. Nothing here is a second copy of
 * anything: every item is READ from the table that already owns it.
 *
 *   nursery  (internal)  ladn.events layer='nursery'  — staff meetings, visits,
 *                        appointments, inspections, supplier visits — plus
 *                        ladn.outings (trips) and opted-in staff birthdays.
 *                        Managers write; all staff read it on EY and HR.
 *   parents  (everyone)  ladn.events layer='parents' AND is_published — term dates,
 *                        closures, inset days, stay-and-play, events — plus
 *                        ladn.school_terms (term and half-term dates) and the
 *                        WEEKLY PLANNING overlay (ladn.weekly_plans /
 *                        ladn.termly_plan_days): per day its activities,
 *                        resources and the theme of the week.
 *   managers (3 people)  ladn.events layer='managers' — Toby, the office manager and the admissions lead only,
 *                        with a message thread per event and a general channel.
 *
 * AUDIENCE RULES, in one place:
 *   - a parent is served the parents layer only, and only published rows;
 *   - the planning overlay served to a parent comes from PUBLISHED term plans only
 *     (b290) and never carries a child's name, a staff name or a child id;
 *   - the managers layer never leaves the hub, on any portal;
 *   - the nursery layer is read-only for everyone but the hub and managers/deputies.
 */

const LAYERS = ['nursery', 'parents', 'managers'];

// Category → the colour token the UI uses. Tokens only: no hex anywhere.
const CATEGORIES = {
  // nursery
  staff_meeting: { layer: 'nursery', label: 'Staff meeting', token: '--c-blue', icon: '🧑‍🏫' },
  visit:         { layer: 'nursery', label: 'Visit',          token: '--c-blue', icon: '🚪' },
  appointment:   { layer: 'nursery', label: 'Appointment',    token: '--c-blue', icon: '📎' },
  inspection:    { layer: 'nursery', label: 'Inspection',     token: '--c-red',  icon: '📋' },
  supplier:      { layer: 'nursery', label: 'Supplier visit', token: '--c-blue', icon: '📦' },
  training:      { layer: 'nursery', label: 'Training',       token: '--c-blue', icon: '🎓' },
  birthday:      { layer: 'nursery', label: 'Birthday',       token: '--c-purple', icon: '🎂' },
  trip:          { layer: 'nursery', label: 'Trip',           token: '--c-green', icon: '🚌' },
  // parents
  term:          { layer: 'parents', label: 'Term dates',     token: '--c-green', icon: '📅' },
  half_term:     { layer: 'parents', label: 'Half term',      token: '--c-orange', icon: '🏖️' },
  closure:       { layer: 'parents', label: 'Closure',        token: '--c-red',    icon: '🚫' },
  inset:         { layer: 'parents', label: 'Inset day',      token: '--c-orange', icon: '🧰' },
  stay_and_play: { layer: 'parents', label: 'Stay and play',  token: '--c-green',  icon: '🧸' },
  event:         { layer: 'parents', label: 'Event',          token: '--c-green',  icon: '🎉' },
  planning:      { layer: 'parents', label: 'Planning',       token: '--c-purple', icon: '🎨' },
  // managers
  manager:       { layer: 'managers', label: 'Managers',      token: '--c-purple', icon: '🔒' },
};

// Which categories a layer offers when you create something.
function categoriesFor(layer) {
  return Object.entries(CATEGORIES)
    .filter(([, v]) => v.layer === layer)
    .filter(([k]) => !['term', 'half_term', 'birthday', 'trip', 'planning'].includes(k)) // derived, not created here
    .map(([k, v]) => ({ key: k, label: v.label, icon: v.icon, token: v.token }));
}

const MGR_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher'];

/** managersHubIds(db) — the three. Setting first, else every ACTIVE role='manager'. */
async function managersHubIds(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='managers_hub_staff_ids'`);
    if (rows.length && rows[0].value) {
      const ids = JSON.parse(rows[0].value);
      if (Array.isArray(ids) && ids.length) return ids.map(Number).filter(Number.isInteger);
    }
  } catch (_) { /* unset or not valid JSON — fall through to the role */ }
  try {
    const { rows } = await db.query(`SELECT id FROM staff WHERE is_active = true AND role = 'manager' ORDER BY id`);
    return rows.map(r => r.id);
  } catch (_) { return [1]; }
}

async function inManagersHub(db, user) {
  if (!user || !user.id) return false;
  const ids = await managersHubIds(db);
  return ids.includes(Number(user.id));
}

function canEditNursery(user) {
  return !!user && hasRole(user, MGR_ROLES);
}
function canEditParents(user) {
  // b405 kept room leaders able to post a parent-facing event. Toby's open
  // decision — not changed here.
  return !!user && (hasRole(user, MGR_ROLES) || user.role === 'room_leader');
}

/** Which layers this viewer may read at all. */
async function readableLayers(db, user, portal) {
  if (portal === 'parents' || (user && user.role === 'parent')) return ['parents'];
  const out = ['nursery', 'parents'];
  if (await inManagersHub(db, user)) out.push('managers');
  return out;
}

const ymd = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function weeksBetween(from, to) {
  const out = [];
  let w = mondayOf(from);
  const end = new Date(to + 'T00:00:00Z');
  for (let i = 0; i < 60; i++) {
    const d = new Date(w + 'T00:00:00Z');
    if (d > end) break;
    out.push(w);
    d.setUTCDate(d.getUTCDate() + 7);
    w = d.toISOString().slice(0, 10);
  }
  return out;
}

/** events rows → calendar items */
function eventItem(r) {
  const cat = r.category || (r.layer === 'managers' ? 'manager' : r.layer === 'nursery' ? 'appointment' : 'event');
  const meta = CATEGORIES[cat] || CATEGORIES.event;
  return {
    key: 'event:' + r.id,
    source: 'events',
    id: r.id,
    layer: r.layer,
    category: cat,
    category_label: meta.label,
    icon: meta.icon,
    token: meta.token,
    title: r.title,
    description: r.description || null,
    date: ymd(r.event_date),
    end_date: ymd(r.end_date) || null,
    start_time: r.start_time || null,
    end_time: r.end_time || null,
    all_day: !!r.all_day || (!r.start_time && !r.end_time),
    location: r.location || null,
    audience: r.audience || null,
    room_name: r.room_name || null,
    rsvp_required: !!r.rsvp_required,
    capacity: r.capacity == null ? null : Number(r.capacity),
    is_published: r.is_published !== false,
    staff_ids: Array.isArray(r.staff_ids) ? r.staff_ids : null,
    editable: true,
    message_count: r.message_count == null ? undefined : Number(r.message_count),
  };
}

/**
 * collect(db, opts) — the unified item list.
 * opts: { from, to, layers[], portal, user, includePlanning (default true), roomId, publicView }
 */
async function collect(db, opts = {}) {
  const from = ymd(opts.from) || ymd(new Date());
  const to   = ymd(opts.to)   || from;
  const allowed = await readableLayers(db, opts.user, opts.portal);
  const want = (Array.isArray(opts.layers) && opts.layers.length ? opts.layers : allowed)
    .filter(l => allowed.includes(l));
  // publicView forces the parent-facing rules on (published rows only, published
  // term plans only) even when the caller could read more — the parents iCal feed
  // and the parents-portal API both set it, so neither can leak a draft.
  const forParent = opts.publicView === true
    || (want.length === 1 && want[0] === 'parents' && allowed.length === 1);
  const items = [];

  // ── ladn.events, by layer ──────────────────────────────────────────────────
  if (want.length) {
    const pubClause = forParent ? 'AND e.is_published = true' : '';
    const { rows } = await db.query(`
      SELECT e.*, r.name AS room_name,
             (SELECT count(*) FROM manager_hub_messages m
               WHERE m.event_id = e.id AND m.deleted_at IS NULL)::int AS message_count
        FROM events e
        LEFT JOIN rooms r ON r.id::text = e.audience
       WHERE e.layer = ANY($1::text[])
         AND COALESCE(e.end_date, e.event_date) >= $2::date
         AND e.event_date <= $3::date
         ${pubClause}
       ORDER BY e.event_date, e.start_time NULLS FIRST, e.id`,
      [want, from, to]);
    for (const r of rows) {
      const it = eventItem(r);
      // A parent-facing answer carries nothing internal. staff_ids is WHO IS
      // EXPECTED TO BE THERE (b184) — a staff roster for the event — and the
      // sandbox probe caught it reaching the parents payload. Dropped here, with
      // the other staff-side fields, rather than per caller, so every parent
      // surface (the portal API and the iCal feed) gets the same answer.
      if (forParent) { delete it.staff_ids; delete it.audience; delete it.message_count; delete it.editable; }
      items.push(it);
    }
  }

  // ── Term and half-term dates: ladn.school_terms (parents layer) ────────────
  if (want.includes('parents')) {
    try {
      const { rows } = await db.query(
        `SELECT id, name, start_date, end_date FROM school_terms
          WHERE end_date >= $1::date AND start_date <= $2::date ORDER BY start_date`, [from, to]);
      for (const t of rows) {
        items.push({
          key: 'term:' + t.id, source: 'school_terms', id: t.id, layer: 'parents',
          category: 'term', category_label: 'Term dates', icon: CATEGORIES.term.icon, token: CATEGORIES.term.token,
          title: t.name, description: null,
          date: ymd(t.start_date), end_date: ymd(t.end_date),
          all_day: true, span: true, editable: false,
          edit_href: '/admin/events-calendar/term-dates',
        });
      }
    } catch (e) { if (e.code !== '42P01') throw e; }
  }

  // ── Trips: ladn.outings (nursery layer; destination only, never a child) ───
  if (want.includes('nursery')) {
    try {
      const { rows } = await db.query(
        `SELECT o.id, o.date, o.destination, o.outing_type, o.departure_time, o.return_time,
                r.name AS room_name
           FROM outings o LEFT JOIN rooms r ON r.id = o.room_id
          WHERE o.date BETWEEN $1::date AND $2::date ORDER BY o.date`, [from, to]);
      for (const o of rows) {
        items.push({
          key: 'outing:' + o.id, source: 'outings', id: o.id, layer: 'nursery',
          category: 'trip', category_label: 'Trip', icon: CATEGORIES.trip.icon, token: CATEGORIES.trip.token,
          title: 'Trip: ' + o.destination,
          description: o.outing_type || null,
          date: ymd(o.date), end_date: null,
          start_time: o.departure_time ? String(o.departure_time).slice(0, 5) : null,
          end_time: o.return_time ? String(o.return_time).slice(0, 5) : null,
          all_day: !o.departure_time,
          room_name: o.room_name || null,
          editable: false, edit_href: '/admin/curriculum/trips',
        });
      }
    } catch (e) { if (e.code !== '42P01') throw e; }
  }

  // ── Staff birthdays, OPT IN (nursery layer). Day and month only, never a year ──
  if (want.includes('nursery')) {
    try {
      const { rows } = await db.query(
        `SELECT id, first_name, preferred_name, date_of_birth FROM staff
          WHERE is_active = true AND birthday_on_calendar = true AND date_of_birth IS NOT NULL`);
      const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
      for (const s of rows) {
        const dob = ymd(s.date_of_birth);
        for (let y = y0; y <= y1; y++) {
          const d = y + dob.slice(4);
          if (d < from || d > to) continue;
          items.push({
            key: `birthday:${s.id}:${y}`, source: 'staff', id: s.id, layer: 'nursery',
            category: 'birthday', category_label: 'Birthday',
            icon: CATEGORIES.birthday.icon, token: CATEGORIES.birthday.token,
            title: `${s.preferred_name || s.first_name}’s birthday`,
            description: null, date: d, end_date: null, all_day: true,
            editable: false, edit_href: '/admin/staff/list',
          });
        }
      }
    } catch (e) { if (e.code !== '42P01' && e.code !== '42703') throw e; }
  }

  // ── The weekly planning overlay (parents layer) ────────────────────────────
  if (want.includes('parents') && opts.includePlanning !== false) {
    items.push(...await planningOverlay(db, from, to, { parentsOnly: forParent, roomId: opts.roomId }));
  }

  items.sort((a, b) => (a.date === b.date
    ? String(a.start_time || '').localeCompare(String(b.start_time || '')) || a.key.localeCompare(b.key)
    : a.date.localeCompare(b.date)));
  return items;
}

const DAY_INDEX = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4 };

/**
 * planningOverlay — per day, the activities and resources, and the theme of the week.
 * Rendered FROM ladn.weekly_plans (and published ladn.termly_plan_days), never copied.
 * No child name, no child id and no staff name is ever put on an overlay item.
 */
async function planningOverlay(db, from, to, opts = {}) {
  const out = [];
  const weeks = weeksBetween(from, to);
  if (!weeks.length) return out;
  const roomFilter = opts.roomId ? ' AND room_id = $2::int' : '';
  const params = opts.roomId ? [weeks, Number(opts.roomId)] : [weeks];
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT wp.room_id, wp.week_commencing, wp.theme, wp.day, wp.activity_title, wp.activity_type,
              wp.resources, wp.eyfs_areas, r.name AS room_name
         FROM weekly_plans wp LEFT JOIN rooms r ON r.id = wp.room_id
        WHERE wp.week_commencing = ANY($1::date[])${roomFilter}
        ORDER BY wp.week_commencing, wp.room_id, wp.id`, params));
  } catch (e) { if (e.code !== '42P01') throw e; return out; }

  // Published termly plan days, which is where a room that uses the termly planner keeps its days.
  let tpd = [];
  try {
    ({ rows: tpd } = await db.query(
      `SELECT w.room_id, w.week_commencing, d.weekday, d.title, d.category_slug, r.name AS room_name,
              p.status, p.theme
         FROM termly_plan_weeks w
         JOIN term_plans p ON p.id = w.plan_id
         JOIN termly_plan_days d ON d.plan_id = w.plan_id AND d.week_no = w.week_no AND d.room_id = w.room_id
         LEFT JOIN rooms r ON r.id = w.room_id
        WHERE w.week_commencing = ANY($1::date[])${opts.roomId ? ' AND w.room_id = $2::int' : ''}
        ORDER BY w.week_commencing, w.room_id, d.weekday`, params));
  } catch (e) { if (e.code !== '42P01' && e.code !== '42703') { /* shape differs on demos */ } }

  const dayDate = (week, day) => {
    const i = DAY_INDEX[String(day || '').toLowerCase()];
    if (i == null) return null;
    const d = new Date(ymd(week) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  };

  // group by (room, date) so a day is ONE calendar chip listing its activities
  const buckets = new Map();
  const put = (roomId, roomName, week, date, theme, activity, resources) => {
    if (!date || date < from || date > to) return;
    const k = `${roomId || 0}|${date}`;
    if (!buckets.has(k)) buckets.set(k, { roomId, roomName, week: ymd(week), date, theme: theme || null, activities: [], resources: [] });
    const b = buckets.get(k);
    if (!b.theme && theme) b.theme = theme;
    if (activity) b.activities.push(activity);
    if (resources) b.resources.push(resources);
  };

  for (const r of rows) put(r.room_id, r.room_name, r.week_commencing, dayDate(r.week_commencing, r.day), r.theme, r.activity_title, r.resources);
  for (const d of tpd) {
    if (opts.parentsOnly && d.status !== 'published') continue;   // b290 — drafts stop here
    put(d.room_id, d.room_name, d.week_commencing, dayDate(d.week_commencing, ['monday','tuesday','wednesday','thursday','friday'][(d.weekday || 1) - 1]), d.theme, d.title, null);
  }

  for (const b of buckets.values()) {
    const acts = [...new Set(b.activities)].filter(Boolean);
    const res  = [...new Set(b.resources)].filter(Boolean);
    out.push({
      key: `planning:${b.roomId || 0}:${b.date}`,
      source: 'weekly_plans', id: null, layer: 'parents',
      category: 'planning', category_label: 'Planning',
      icon: CATEGORIES.planning.icon, token: CATEGORIES.planning.token,
      title: b.theme ? `Theme: ${b.theme}` : 'Planned activities',
      theme: b.theme, activities: acts, resources: res,
      room_id: b.roomId, room_name: b.roomName || null,
      date: b.date, end_date: null, all_day: true, overlay: true, editable: false,
      week_commencing: b.week,
      edit_href: `/admin/curriculum/planning?room=${b.roomId || ''}&week=${b.week}`,
    });
  }
  return out;
}

module.exports = {
  LAYERS, CATEGORIES, MGR_ROLES, categoriesFor,
  managersHubIds, inManagersHub, readableLayers,
  canEditNursery, canEditParents,
  collect, planningOverlay, eventItem, ymd, mondayOf, weeksBetween,
};
