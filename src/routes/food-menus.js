// src/routes/food-menus.js — b171 (2026-07-28)
// EyLog-parity "Food Menus" settings page backend.
//
// Model: a menu_group is a date-range rotation ("Summer Menu 2026",
// "Winter Menu 2026"). Each group has menu_group_weeks (Week 1..N) which
// auto-rotate week-to-week across the group's date range. Each week's food
// items (menu_items, extended with week_number + room_variation) can carry
// a room/age-group variation.
//
// Mounted at /api/food-menus (see NOTES for the server-unified.js mount
// line — this file does not touch server-unified.js itself).
//
// Reuses the EXISTING menu_groups / menu_items tables (already live via
// src/routes/kitchen.js, parents.js, diary.js) rather than duplicating a
// parallel food-item model — see migrations/2026-07-28-food-menus-rotation.sql.

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const {
  computeWeekNumber,
  getMenuForDate,
  ensureWeeksForGroup,
  toDateStr,
  plannedItems,
} = require('../lib/menu-rotation');

// ── Public / parent-safe routes (registered BEFORE authenticate) ────────────
// Parents authenticate via CF Access at the edge, not a JWT, so the parent
// menu page cannot call the auth-gated routes below. These read-only endpoints
// expose ONLY dish descriptions + allergen labels (no child/family data),
// exactly like /api/menus/public/* — safe to serve without a JWT. Added for
// the parents-app item 7 (summer/winter season menu with a "which season is
// current + which rotation week" calendar overlay).
const _PUB_DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const _PUB_MEAL_ORDER = { breakfast: 1, morning_snack: 2, snack: 2, lunch: 3, afternoon_snack: 4, tea: 5 };
const _PUB_MEAL_LABELS = {
  breakfast: 'Breakfast', morning_snack: 'Morning Snack', snack: 'Snack',
  lunch: 'Lunch', afternoon_snack: 'Afternoon Snack', tea: 'Tea',
};

// GET /public/season-menus?room=preschool
// Returns every season menu group (Summer / Winter …), which one covers today,
// the live rotation week for the current group, and each week's items grouped
// by day → meal. Everything the parent menu page needs in one call.
router.get('/public/season-menus', async (req, res) => {
  try {
    const db = getPool();
    const today = new Date().toISOString().slice(0, 10);
    // room preference: null / 'preschool' → the generic (room_variation NULL)
    // menu; a specific room falls back to generic where it has no variation.
    const roomReq = req.query.room && req.query.room !== 'preschool' ? String(req.query.room) : null;

    // b405: WHERE is_active=true — an inactive/superseded group (e.g. an old
    // orphaned "Summer Term" row left over from a prior season) must not
    // render as an extra season tab alongside the real current one.
    const { rows: groups } = await db.query('SELECT * FROM menu_groups WHERE is_active = true ORDER BY date_from');
    if (!groups.length) return res.json({ today, room: roomReq, seasons: [] });

    // b405: the kitchen's dated today-override (menu_plans, POST /api/menus/
    // today-override) only maps onto ONE real calendar week — the live one —
    // so it's only ever applied to whichever week below turns out to be the
    // current one. Fetched once; a query failure must not break the page.
    let planned = [];
    try { planned = await plannedItems(db, today, roomReq); }
    catch (e) { console.error('[food-menus] dated plans:', e.message); }

    const groupIds = groups.map(g => g.id);
    const { rows: weeks } = await db.query(
      `SELECT * FROM menu_group_weeks WHERE menu_group_id = ANY($1::int[])
       ORDER BY menu_group_id, COALESCE(sort_order, week_number), week_number`,
      [groupIds]
    );
    const { rows: items } = await db.query(
      `SELECT id, menu_group_id, week_number, day_of_week, meal_type,
              description, allergens, room_variation
       FROM menu_items WHERE menu_group_id = ANY($1::int[])
       ORDER BY menu_group_id, week_number, day_of_week`,
      [groupIds]
    );

    // items indexed by group → week → day+meal, deduped so a room-variation row
    // wins over the generic row for the same slot when a room is requested.
    const bucket = {}; // bucket[groupId][weekNum]['day|meal'] = {item, score}
    for (const it of items) {
      if (it.room_variation !== null && it.room_variation !== roomReq) continue; // skip other rooms
      // b405: seed placeholder text (e.g. "Placeholder — Lunch TBC (Toby to
      // import real Summer Menu item)") must never render to a parent —
      // same convention menu-rotation.js's overlayPlans() already applies
      // to the dated-plan path; this is the rotation-table equivalent.
      if (/^\s*placeholder/i.test(it.description || '')) continue;
      const g = (bucket[it.menu_group_id] = bucket[it.menu_group_id] || {});
      const w = (g[it.week_number] = g[it.week_number] || {});
      const key = `${it.day_of_week}|${it.meal_type}`;
      const score = it.room_variation !== null ? 1 : 0;
      if (!w[key] || score > w[key].score) w[key] = { item: it, score };
    }

    const seasons = groups.map(group => {
      const isCurrent = !!group.is_active
        && toDateStr(group.date_from) <= today && toDateStr(group.date_to) >= today;
      const currentWeek = isCurrent ? computeWeekNumber(group, today) : null;
      const groupWeeks = weeks.filter(w => w.menu_group_id === group.id);
      const weeksOut = groupWeeks.map(w => {
        const slots = (bucket[group.id] && bucket[group.id][w.week_number]) || {};
        const byDay = {};
        for (const { item } of Object.values(slots)) {
          const d = (byDay[item.day_of_week] = byDay[item.day_of_week] || {
            day_of_week: item.day_of_week,
            day_name: _PUB_DAY_NAMES[item.day_of_week] || String(item.day_of_week),
            meals: [],
          });
          d.meals.push({
            meal_type: item.meal_type,
            meal_label: _PUB_MEAL_LABELS[item.meal_type] || item.meal_type,
            description: item.description || '',
            allergens: item.allergens || [],
          });
        }
        // b405: the live week is the only one where an abstract rotation
        // week-number corresponds to one real calendar week — apply the
        // kitchen's dated override(s) there so this page agrees with the
        // same resolver (menu-rotation.js's plannedItems/getMenuForDate)
        // used elsewhere, instead of silently ignoring them as before.
        if (currentWeek === w.week_number && planned.length) {
          for (const p of planned) {
            const d = (byDay[p.day_of_week] = byDay[p.day_of_week] || {
              day_of_week: p.day_of_week,
              day_name: _PUB_DAY_NAMES[p.day_of_week] || String(p.day_of_week),
              meals: [],
            });
            d.meals = d.meals.filter(m => m.meal_type !== 'lunch');
            d.meals.push({
              meal_type: 'lunch',
              meal_label: _PUB_MEAL_LABELS.lunch,
              description: p.description || '',
              allergens: p.allergens || [],
            });
          }
        }
        const days = Object.values(byDay).sort((a, b) => a.day_of_week - b.day_of_week);
        days.forEach(d => d.meals.sort(
          (a, b) => (_PUB_MEAL_ORDER[a.meal_type] || 9) - (_PUB_MEAL_ORDER[b.meal_type] || 9)
        ));
        return {
          week_number: w.week_number,
          name: w.name || `Week ${w.week_number}`,
          is_current: currentWeek === w.week_number,
          days,
        };
      });
      return {
        id: group.id,
        name: group.name,
        date_from: toDateStr(group.date_from),
        date_to: toDateStr(group.date_to),
        is_active: !!group.is_active,
        rotation_weeks: group.rotation_weeks,
        is_current: isCurrent,
        current_week: currentWeek,
        weeks: weeksOut,
      };
    });

    res.json({ today, room: roomReq, seasons });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.use(authenticate);

const canManage = (req) => hasRole(req.user, ['manager', 'deputy_manager', 'admin']);
function requireManager(req, res, next) {
  if (!canManage(req)) return res.status(403).json({ error: 'Manager only' });
  next();
}

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MEAL_ORDER = { breakfast: 1, morning_snack: 2, snack: 2, lunch: 3, afternoon_snack: 4, tea: 5 };

// ── Groups ───────────────────────────────────────────────────────────────

// GET /groups — list all menu groups with their weeks + item counts
router.get('/groups', async (req, res) => {
  try {
    const db = getPool();
    const { rows: groups } = await db.query(
      `SELECT * FROM menu_groups ORDER BY date_from DESC`
    );
    const { rows: weeks } = await db.query(
      `SELECT w.*, COUNT(mi.id) AS item_count
       FROM menu_group_weeks w
       LEFT JOIN menu_items mi ON mi.menu_group_id = w.menu_group_id AND mi.week_number = w.week_number
       GROUP BY w.id
       ORDER BY w.menu_group_id, COALESCE(w.sort_order, w.week_number), w.week_number`
    );
    const byGroup = {};
    for (const w of weeks) {
      (byGroup[w.menu_group_id] = byGroup[w.menu_group_id] || []).push({ ...w, item_count: parseInt(w.item_count, 10) });
    }
    const today = new Date().toISOString().slice(0, 10);
    // NB: g.date_from/date_to come back from pg as Date objects — comparing
    // them directly with <= against a "YYYY-MM-DD" string coerces via
    // Date.prototype.toString() (e.g. "Sun Apr 12 2026...") and silently
    // gives the wrong answer. Always go through toDateStr() first (same
    // fix as the week-rotation maths bug in src/lib/menu-rotation.js).
    const out = groups.map(g => ({
      ...g,
      weeks: byGroup[g.id] || [],
      covers_today: g.is_active && toDateStr(g.date_from) <= today && toDateStr(g.date_to) >= today,
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /groups/:id — single group with weeks
router.get('/groups/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM menu_groups WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rows: weeks } = await db.query(
      `SELECT * FROM menu_group_weeks WHERE menu_group_id=$1 ORDER BY COALESCE(sort_order, week_number), week_number`,
      [req.params.id]
    );
    res.json({ ...rows[0], weeks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /groups — create a new menu group (rotation window) + its weeks
// Body: { name, date_from, date_to, rotation_weeks=4, is_active=true, notes }
router.post('/groups', requireManager, async (req, res) => {
  const { name, date_from, date_to, rotation_weeks, is_active, notes } = req.body || {};
  if (!name || !date_from || !date_to) return res.status(400).json({ error: 'name, date_from, date_to required' });
  const weeks = Math.max(1, parseInt(rotation_weeks, 10) || 4);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO menu_groups (name, date_from, date_to, is_active, rotation_weeks, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, date_from, date_to, is_active !== false, weeks, notes || null]
    );
    await ensureWeeksForGroup(db, rows[0].id, weeks);
    const { rows: weekRows } = await db.query(
      'SELECT * FROM menu_group_weeks WHERE menu_group_id=$1 ORDER BY week_number', [rows[0].id]
    );
    res.status(201).json({ ...rows[0], weeks: weekRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /groups/:id — edit a group. Changing rotation_weeks tops up any missing weeks.
router.put('/groups/:id', requireManager, async (req, res) => {
  const { name, date_from, date_to, rotation_weeks, is_active, notes } = req.body || {};
  try {
    const db = getPool();
    const updates = [], vals = [];
    if (name !== undefined)      { vals.push(name);      updates.push(`name=$${vals.length}`); }
    if (date_from !== undefined) { vals.push(date_from); updates.push(`date_from=$${vals.length}`); }
    if (date_to !== undefined)   { vals.push(date_to);   updates.push(`date_to=$${vals.length}`); }
    if (rotation_weeks !== undefined) { vals.push(Math.max(1, parseInt(rotation_weeks, 10) || 1)); updates.push(`rotation_weeks=$${vals.length}`); }
    if (is_active !== undefined) { vals.push(!!is_active); updates.push(`is_active=$${vals.length}`); }
    if (notes !== undefined)     { vals.push(notes);      updates.push(`notes=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await db.query(`UPDATE menu_groups SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rotation_weeks !== undefined) await ensureWeeksForGroup(db, rows[0].id, rows[0].rotation_weeks);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /groups/:id/clone — clone a group (new date range) plus its weeks + items.
// Body: { name, date_from, date_to, is_active=true }
router.post('/groups/:id/clone', requireManager, async (req, res) => {
  const { name, date_from, date_to, is_active } = req.body || {};
  if (!name || !date_from || !date_to) return res.status(400).json({ error: 'name, date_from, date_to required' });
  try {
    const db = getPool();
    const { rows: src } = await db.query('SELECT * FROM menu_groups WHERE id=$1', [req.params.id]);
    if (!src.length) return res.status(404).json({ error: 'Source group not found' });
    const source = src[0];

    const { rows: created } = await db.query(
      `INSERT INTO menu_groups (name, date_from, date_to, is_active, rotation_weeks, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, date_from, date_to, is_active !== false, source.rotation_weeks, source.notes]
    );
    const newGroup = created[0];
    await ensureWeeksForGroup(db, newGroup.id, newGroup.rotation_weeks);

    const { rows: items } = await db.query('SELECT * FROM menu_items WHERE menu_group_id=$1', [source.id]);
    for (const it of items) {
      await db.query(
        `INSERT INTO menu_items (menu_group_id, day_of_week, meal_type, description, allergens, week_number, room_variation)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newGroup.id, it.day_of_week, it.meal_type, it.description, it.allergens, it.week_number, it.room_variation]
      );
    }
    const { rows: weekRows } = await db.query('SELECT * FROM menu_group_weeks WHERE menu_group_id=$1 ORDER BY week_number', [newGroup.id]);
    res.status(201).json({ ...newGroup, weeks: weekRows, items_cloned: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /groups/:id/sequence — reorder / rename weeks in one go.
// Body: { weeks: [{ id, sort_order, name }, ...] }
router.put('/groups/:id/sequence', requireManager, async (req, res) => {
  const { weeks } = req.body || {};
  if (!Array.isArray(weeks)) return res.status(400).json({ error: 'weeks[] required' });
  try {
    const db = getPool();
    for (const w of weeks) {
      if (!w.id) continue;
      await db.query(
        `UPDATE menu_group_weeks SET sort_order=COALESCE($1,sort_order), name=COALESCE($2,name)
         WHERE id=$3 AND menu_group_id=$4`,
        [w.sort_order ?? null, w.name ?? null, w.id, req.params.id]
      );
    }
    const { rows } = await db.query(
      'SELECT * FROM menu_group_weeks WHERE menu_group_id=$1 ORDER BY COALESCE(sort_order, week_number), week_number',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /groups/:id — remove a group (cascades to its weeks; items keep
// their menu_group_id FK so this is blocked if items still reference it).
router.delete('/groups/:id', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const { rows: items } = await db.query('SELECT COUNT(*) FROM menu_items WHERE menu_group_id=$1', [req.params.id]);
    if (parseInt(items[0].count, 10) > 0) {
      return res.status(409).json({ error: 'Group still has menu items — delete or reassign items first', item_count: parseInt(items[0].count, 10) });
    }
    const { rowCount } = await db.query('DELETE FROM menu_groups WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Weeks ────────────────────────────────────────────────────────────────

// GET /weeks/:weekId/items — items for one week, grouped by day/meal
router.get('/weeks/:weekId/items', async (req, res) => {
  try {
    const db = getPool();
    const { rows: weekRows } = await db.query('SELECT * FROM menu_group_weeks WHERE id=$1', [req.params.weekId]);
    if (!weekRows.length) return res.status(404).json({ error: 'Week not found' });
    const week = weekRows[0];
    const { rows: items } = await db.query(
      `SELECT * FROM menu_items WHERE menu_group_id=$1 AND week_number=$2
       ORDER BY day_of_week, meal_type, room_variation NULLS FIRST`,
      [week.menu_group_id, week.week_number]
    );
    res.json({ week, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /weeks/:weekId/items — add a food item to a week
// Body: { day_of_week(1-5 Mon-Fri), meal_type, description, allergens[], room_variation? }
router.post('/weeks/:weekId/items', requireManager, async (req, res) => {
  const { day_of_week, meal_type, description, allergens, room_variation } = req.body || {};
  if (day_of_week === undefined || !meal_type) return res.status(400).json({ error: 'day_of_week, meal_type required' });
  try {
    const db = getPool();
    const { rows: weekRows } = await db.query('SELECT * FROM menu_group_weeks WHERE id=$1', [req.params.weekId]);
    if (!weekRows.length) return res.status(404).json({ error: 'Week not found' });
    const week = weekRows[0];
    const { rows } = await db.query(
      `INSERT INTO menu_items (menu_group_id, day_of_week, meal_type, description, allergens, week_number, room_variation)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [week.menu_group_id, day_of_week, meal_type, description || '', allergens || [], week.week_number, room_variation || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /items/:id — edit a food item
router.put('/items/:id', requireManager, async (req, res) => {
  const { description, allergens, meal_type, day_of_week, room_variation } = req.body || {};
  try {
    const db = getPool();
    const updates = [], vals = [];
    if (description !== undefined)    { vals.push(description);    updates.push(`description=$${vals.length}`); }
    if (allergens !== undefined)      { vals.push(allergens);      updates.push(`allergens=$${vals.length}`); }
    if (meal_type !== undefined)      { vals.push(meal_type);      updates.push(`meal_type=$${vals.length}`); }
    if (day_of_week !== undefined)    { vals.push(day_of_week);    updates.push(`day_of_week=$${vals.length}`); }
    if (room_variation !== undefined) { vals.push(room_variation || null); updates.push(`room_variation=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await db.query(`UPDATE menu_items SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /items/:id
router.delete('/items/:id', requireManager, async (req, res) => {
  try {
    const { rowCount } = await getPool().query('DELETE FROM menu_items WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Active-period helper (the reusable bit) ─────────────────────────────

// GET /active?date=YYYY-MM-DD&room=baby_room — resolve group+week+items for a date.
// This is the general "which rotation period + week is showing today" helper;
// Toby also wants this pattern for headcount/invoice/waiting-list switch-over
// timing later — the date/room resolution logic lives in src/lib/menu-rotation.js
// so it can be reused outside food menus without copy-pasting the maths.
router.get('/active', async (req, res) => {
  try {
    const db = getPool();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const result = await getMenuForDate(db, date, req.query.room || null);
    res.json({
      date,
      room: req.query.room || null,
      group: result.group,
      week_number: result.week_number,
      week: result.week,
      items: result.items.map(i => ({ ...i, day_name: DAY_NAMES[i.day_of_week] || i.day_of_week })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /this-week — convenience wrapper for /active with no query params,
// grouped by day for the "this week's menu" view.
router.get('/this-week', async (req, res) => {
  try {
    const db = getPool();
    const date = new Date().toISOString().slice(0, 10);
    const result = await getMenuForDate(db, date, req.query.room || null);
    const byDay = {};
    for (const item of result.items) {
      const key = item.day_of_week;
      (byDay[key] = byDay[key] || { day_of_week: key, day_name: DAY_NAMES[key] || key, meals: [] })
        .meals.push(item);
    }
    Object.values(byDay).forEach(d => d.meals.sort((a, b) => (MEAL_ORDER[a.meal_type] || 9) - (MEAL_ORDER[b.meal_type] || 9)));
    res.json({
      date,
      group: result.group,
      week_number: result.week_number,
      week: result.week,
      days: Object.values(byDay).sort((a, b) => a.day_of_week - b.day_of_week),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /resolve-week?group_id=&date= — just the computed week number for a
// group + date, for the UI to highlight "this is the week that's live".
router.get('/resolve-week', async (req, res) => {
  const { group_id, date } = req.query;
  if (!group_id) return res.status(400).json({ error: 'group_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM menu_groups WHERE id=$1', [group_id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const weekNumber = computeWeekNumber(rows[0], date || new Date().toISOString().slice(0, 10));
    res.json({ group_id: rows[0].id, date: date || new Date().toISOString().slice(0, 10), week_number: weekNumber });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
