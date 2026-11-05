// src/lib/menu-rotation.js — b171 (2026-07-28)
//
// Shared "which menu group / which rotation week is active for a given date"
// helper. Models EyLog's Food Menus screen: a menu_group is a date-range
// rotation (e.g. "Summer Menu 2026", "Winter Menu 2026") that cycles through
// menu_group_weeks (Week 1..N) starting from the group's date_from (aligned
// to the Monday of that week), repeating every `rotation_weeks` weeks.
//
// Reused by: src/routes/food-menus.js, src/routes/kitchen.js (chef "today"/
// day-sheet/allergy briefing), src/routes/parents.js (parent menu page),
// src/routes/diary.js (diary "today's menu").
//
// Also reusable, per Toby's note, as the general term/rotation "active
// period" helper for headcount/invoices/waiting-list switch-over timing —
// not wired up there yet, just kept generic enough to reuse.

const DAY_MS = 24 * 60 * 60 * 1000;

// Monday 00:00 (as a UTC-agnostic local Date) of the ISO week containing dateStr.
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// IMPORTANT: node-postgres returns SQL `date` columns as local-midnight Date
// objects (e.g. a stored 2026-04-13 becomes `new Date(2026,3,13)` in the
// server's local timezone). Using toISOString() here would convert to UTC
// and silently shift the date back a day whenever the server runs ahead of
// UTC (BST) — which broke the week-rotation maths during testing. Always
// read local getters, never toISOString(), when turning a pg Date back into
// a YYYY-MM-DD string.
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 1-indexed active week number (1..rotation_weeks) for a group on a given date.
function computeWeekNumber(group, dateStr) {
  const rotationWeeks = Math.max(1, parseInt(group.rotation_weeks, 10) || 1);
  const startMonday = mondayOf(
    group.date_from instanceof Date ? toDateStr(group.date_from) : group.date_from
  );
  const targetMonday = mondayOf(dateStr);
  const diffDays = Math.round((targetMonday.getTime() - startMonday.getTime()) / DAY_MS);
  const weeksSince = Math.floor(diffDays / 7);
  const normalized = ((weeksSince % rotationWeeks) + rotationWeeks) % rotationWeeks;
  return normalized + 1;
}

// Find the active menu_group for a date: prefer an is_active group whose
// date range covers the date; fall back to the most recently-ending group
// (matches the pre-existing fallback behaviour in kitchen.js /current).
async function getActiveMenuGroup(db, dateStr) {
  const { rows } = await db.query(
    `SELECT * FROM menu_groups
     WHERE is_active = true AND date_from <= $1::date AND date_to >= $1::date
     ORDER BY date_from DESC LIMIT 1`,
    [dateStr]
  );
  if (rows[0]) return rows[0];
  const { rows: latest } = await db.query(
    `SELECT * FROM menu_groups ORDER BY date_to DESC LIMIT 1`
  );
  return latest[0] || null;
}

async function getWeekRow(db, groupId, weekNumber) {
  const { rows } = await db.query(
    `SELECT * FROM menu_group_weeks WHERE menu_group_id=$1 AND week_number=$2`,
    [groupId, weekNumber]
  );
  return rows[0] || null;
}

// Resolve the day/meal items that should show for a date (+ optional room).
// Dedupes so a room-specific and/or week-specific row wins over a generic
// (week_number/room_variation NULL) row for the same day+meal slot.
// b330 (2026-09-15): the dated weekly plans (menu_plans + menu_recipes) hold the
// real menu — loaded from the setting's Word menus and kept in step with EyLog.
// The rotation rows are mostly placeholder text ("Placeholder — Lunch TBC"), so
// the parents' menu page, the kitchen screens and the allergy check showed
// nothing real. Where a dated plan exists for that Monday, its lunch and pudding
// replace the rotation's lunch, and placeholder rows are dropped. The pudding is
// folded into the lunch line because every reader lists a fixed set of meal
// types with no 'pudding' in it (EY kitchen.html would silently drop it).
async function plannedItems(db, dateStr, room) {
  const monday = toDateStr(mondayOf(dateStr));
  const planRoom = (String(room || '') === '1' || /bab/i.test(String(room || ''))) ? 'baby' : 'preschool';
  const { rows } = await db.query(
    `SELECT p.day_of_week, p.meal_type, r.name, r.allergens
       FROM menu_plans p JOIN menu_recipes r ON r.id = p.recipe_id
      WHERE p.week_start_date = $1::date AND p.room = $2
      ORDER BY p.day_of_week, p.meal_type`,
    [monday, planRoom]);
  const byDay = new Map();
  for (const r of rows) {
    const d = byDay.get(r.day_of_week) || {};
    d[r.meal_type] = r;
    byDay.set(r.day_of_week, d);
  }
  const out = [];
  for (const [day, d] of byDay) {
    if (!d.lunch && !d.pudding) continue;
    const parts = [];
    if (d.lunch) parts.push(d.lunch.name);
    if (d.pudding) parts.push(`Pudding: ${d.pudding.name}`);
    const allergens = [...new Set([...((d.lunch && d.lunch.allergens) || []), ...((d.pudding && d.pudding.allergens) || [])])];
    out.push({ id: null, menu_group_id: null, day_of_week: day, meal_type: 'lunch',
               description: parts.join(' · '), allergens, week_number: null,
               room_variation: planRoom, source: 'plan' });
  }
  return out;
}

function overlayPlans(rotationItems, planned) {
  let items = rotationItems.filter(i => !/^\s*placeholder/i.test(i.description || ''));
  if (!planned.length) return items;
  const plannedDays = new Set(planned.map(p => p.day_of_week));
  items = items.filter(i => !(i.meal_type === 'lunch' && plannedDays.has(i.day_of_week))).concat(planned);
  return items.sort((a, b) => a.day_of_week - b.day_of_week || String(a.meal_type).localeCompare(String(b.meal_type)));
}

async function safePlanned(db, dateStr, room) {
  try { return await plannedItems(db, dateStr, room); }
  catch (e) { console.error('[menu-rotation] dated plans:', e.message); return []; }
}

async function getMenuForDate(db, dateStr, room) {
  const group = await getActiveMenuGroup(db, dateStr);
  if (!group) return { group: null, week_number: null, week: null, items: await safePlanned(db, dateStr, room) };

  const weekNumber = computeWeekNumber(group, dateStr);
  const week = await getWeekRow(db, group.id, weekNumber);

  const { rows: candidates } = await db.query(
    `SELECT * FROM menu_items
     WHERE menu_group_id = $1
       AND (week_number IS NULL OR week_number = $2)
       AND (room_variation IS NULL OR room_variation = $3)
     ORDER BY day_of_week, meal_type`,
    [group.id, weekNumber, room || null]
  );

  const best = new Map();
  for (const item of candidates) {
    const key = `${item.day_of_week}|${item.meal_type}`;
    const score = (item.week_number !== null ? 2 : 0) + (item.room_variation !== null ? 1 : 0);
    const existing = best.get(key);
    if (!existing || score > existing.score) best.set(key, { item, score });
  }
  const items = [...best.values()]
    .map(v => v.item)
    .sort((a, b) => a.day_of_week - b.day_of_week || String(a.meal_type).localeCompare(String(b.meal_type)));

  return { group, week_number: weekNumber, week, items: overlayPlans(items, await safePlanned(db, dateStr, room)) };
}

// Ensure menu_group_weeks rows 1..rotationWeeks exist for a group (idempotent).
async function ensureWeeksForGroup(db, groupId, rotationWeeks) {
  const n = Math.max(1, parseInt(rotationWeeks, 10) || 1);
  for (let w = 1; w <= n; w++) {
    await db.query(
      `INSERT INTO menu_group_weeks (menu_group_id, week_number, name, sort_order)
       VALUES ($1, $2, $3, $2)
       ON CONFLICT (menu_group_id, week_number) DO NOTHING`,
      [groupId, w, `Week ${w}`]
    );
  }
}

module.exports = {
  mondayOf,
  toDateStr,
  computeWeekNumber,
  getActiveMenuGroup,
  getWeekRow,
  getMenuForDate,
  ensureWeeksForGroup,
  plannedItems,
  overlayPlans,
};
