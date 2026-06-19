const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /menu/today — today's menu from active menu_group
router.get('/menu/today', async (req, res) => {
  try {
    const db = getPool();
    const dow = new Date().getDay(); // 0=Sun,1=Mon...
    const pgDow = dow === 0 ? 1 : dow === 6 ? 5 : dow; // clamp to 1-5
    const { rows } = await db.query(`
      SELECT mi.meal_type, mi.description, mi.allergens, mg.name as menu_name
      FROM menu_items mi
      JOIN menu_groups mg ON mg.id = mi.menu_group_id
      WHERE mg.is_active = true
        AND mi.day_of_week = $1
        AND (mg.date_from IS NULL OR CURRENT_DATE >= mg.date_from)
        AND (mg.date_to IS NULL OR CURRENT_DATE <= mg.date_to)
      ORDER BY CASE mi.meal_type
        WHEN 'breakfast' THEN 1
        WHEN 'morning_snack' THEN 2
        WHEN 'lunch' THEN 3
        WHEN 'afternoon_snack' THEN 4
        ELSE 5 END
    `, [pgDow]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /menu/week — full week from active menu_group
router.get('/menu/week', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT mi.day_of_week, mi.meal_type, mi.description, mi.allergens, mg.name as menu_name
      FROM menu_items mi
      JOIN menu_groups mg ON mg.id = mi.menu_group_id
      WHERE mg.is_active = true
        AND (mg.date_from IS NULL OR CURRENT_DATE >= mg.date_from)
        AND (mg.date_to IS NULL OR CURRENT_DATE <= mg.date_to)
      ORDER BY mi.day_of_week,
        CASE mi.meal_type WHEN 'breakfast' THEN 1 WHEN 'morning_snack' THEN 2
          WHEN 'lunch' THEN 3 WHEN 'afternoon_snack' THEN 4 ELSE 5 END
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId
router.get('/child/:childId', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 90);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT d.*, s.first_name || ' ' || s.last_name as staff_name
      FROM daily_diary d
      LEFT JOIN staff s ON s.id = d.staff_id
      WHERE d.child_id=$1
      ORDER BY d.date DESC, d.created_at DESC
      LIMIT $2
    `, [req.params.childId, limit]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /today — all diary entries for today
router.get('/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT d.*, c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as staff_name
      FROM daily_diary d
      JOIN children c ON c.id = d.child_id
      LEFT JOIN staff s ON s.id = d.staff_id
      WHERE d.date = CURRENT_DATE
      ORDER BY d.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST / — single or bulk entry
router.post('/', async (req, res) => {
  // Support bulk: { entries: [{child_id, ...}] } or single
  const isArray = Array.isArray(req.body.entries);
  const items = isArray ? req.body.entries : [req.body];
  if (!items.length) return res.status(400).json({ error: 'No entries provided' });
  try {
    const db = getPool();
    const results = [];
    for (const item of items) {
      const { child_id, mood, meals, naps, activities, notes, photo_urls, shared_with_parents,
        lunch, sleep_from, sleep_to, sleep_quality,
        nappy, nappy_time, nappy_notes,
        milk_amount_ml, milk_time, milk_type } = item;
      if (!child_id) continue;
      const { rows } = await db.query(`
        INSERT INTO daily_diary (child_id, staff_id, date, mood, meals, naps, activities, notes, photo_urls, shared_with_parents,
          lunch, sleep_from, sleep_to, sleep_quality, nappy, nappy_time, nappy_notes, milk_amount_ml, milk_time, milk_type)
        VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (child_id, date) DO UPDATE SET
          mood=EXCLUDED.mood, meals=EXCLUDED.meals, naps=EXCLUDED.naps,
          activities=EXCLUDED.activities, notes=EXCLUDED.notes,
          photo_urls=EXCLUDED.photo_urls, shared_with_parents=EXCLUDED.shared_with_parents,
          lunch=EXCLUDED.lunch, sleep_from=EXCLUDED.sleep_from, sleep_to=EXCLUDED.sleep_to,
          sleep_quality=EXCLUDED.sleep_quality, nappy=EXCLUDED.nappy, nappy_time=EXCLUDED.nappy_time,
          nappy_notes=EXCLUDED.nappy_notes, milk_amount_ml=EXCLUDED.milk_amount_ml,
          milk_time=EXCLUDED.milk_time, milk_type=EXCLUDED.milk_type
        RETURNING *
      `, [child_id, req.user.id, mood||null, meals||null, naps||null,
          activities||null, notes||null, photo_urls || [], shared_with_parents !== false,
          lunch||null, sleep_from||null, sleep_to||null, sleep_quality||null,
          nappy||null, nappy_time||null, nappy_notes||null,
          milk_amount_ml||null, milk_time||null, milk_type||null]);
      if (rows[0]) results.push(rows[0]);
    }
    res.status(201).json(isArray ? results : results[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const { mood, meals, naps, activities, notes, photo_urls, shared_with_parents } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE daily_diary
      SET mood=COALESCE($1,mood), meals=COALESCE($2,meals),
          naps=COALESCE($3,naps), activities=COALESCE($4,activities),
          notes=COALESCE($5,notes), photo_urls=COALESCE($6,photo_urls),
          shared_with_parents=COALESCE($7,shared_with_parents)
      WHERE id=$8
      RETURNING *
    `, [mood, meals, naps, activities, notes, photo_urls, shared_with_parents, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── EyWorks-style timeline diary entries ─────────────────────────────────────

// GET /entries?date=2026-05-01&room=baby&child_id=57&type=sleep — entries (all optional filters)
router.get('/entries', async (req, res) => {
  const date     = req.query.date     || new Date().toISOString().slice(0, 10);
  const room     = req.query.room     || null;
  const childId  = req.query.child_id ? parseInt(req.query.child_id, 10) : null;
  const type     = req.query.type     || null;
  try {
    const db = getPool();
    const params = [date];
    let extra = '';
    if (room)    { params.push(`%${room.toLowerCase()}%`); extra += ` AND lower(c.room_name) LIKE $${params.length}`; }
    if (childId) { params.push(childId);                   extra += ` AND de.child_id = $${params.length}`; }
    if (type)    { params.push(type);                      extra += ` AND de.entry_type = $${params.length}`; }
    const { rows } = await db.query(`
      SELECT de.*, c.first_name, c.last_name, c.room as room_name,
             s.first_name || ' ' || s.last_name AS staff_name
      FROM ladn.diary_entries de
      JOIN ladn.children c ON c.id = de.child_id
      LEFT JOIN ladn.staff s ON s.id = de.staff_id
      WHERE de.occurred_at::date = $1
        AND de.deleted_at IS NULL
        ${extra}
      ORDER BY de.occurred_at DESC
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /entries — add one or more entries (fan-out across child_ids)
router.post('/entries', async (req, res) => {
  const { child_ids, entry_type, occurred_at, duration_minutes, food_amount, food_meal,
    nappy_state, drink_ml, drink_type, sleep_quality, notes, share_with_parents } = req.body;
  if (!child_ids || !child_ids.length || !entry_type) {
    return res.status(400).json({ error: 'child_ids and entry_type required' });
  }
  const ts = occurred_at || new Date().toISOString();
  try {
    const db = getPool();
    const ids = [];
    for (const child_id of child_ids) {
      const { rows } = await db.query(`
        INSERT INTO ladn.diary_entries
          (child_id, entry_type, occurred_at, duration_minutes, food_amount, food_meal,
           nappy_state, drink_ml, drink_type, sleep_quality, notes, share_with_parents, staff_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id
      `, [child_id, entry_type, ts, duration_minutes||null, food_amount||null, food_meal||null,
          nappy_state||null, drink_ml||null, drink_type||null, sleep_quality||null,
          notes||null, share_with_parents !== false, req.user.id]);
      if (rows[0]) ids.push(rows[0].id);
    }
    res.status(201).json({ ids });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /entries/:id — edit within 4 hours
router.patch('/entries/:id', async (req, res) => {
  const db = getPool();
  try {
    const existing = await db.query(
      'SELECT * FROM ladn.diary_entries WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
    const entry = existing.rows[0];
    const ageHours = (Date.now() - new Date(entry.created_at).getTime()) / 3600000;
    if (ageHours > 4 && req.user.role !== 'manager' && req.user.role !== 'deputy_manager') {
      return res.status(403).json({ error: 'Can only edit entries within 4 hours' });
    }
    const { food_amount, food_meal, nappy_state, drink_ml, drink_type, sleep_quality,
      duration_minutes, notes, share_with_parents, occurred_at } = req.body;
    const { rows } = await db.query(`
      UPDATE ladn.diary_entries SET
        food_amount=COALESCE($1,food_amount), food_meal=COALESCE($2,food_meal),
        nappy_state=COALESCE($3,nappy_state), drink_ml=COALESCE($4,drink_ml),
        drink_type=COALESCE($5,drink_type), sleep_quality=COALESCE($6,sleep_quality),
        duration_minutes=COALESCE($7,duration_minutes), notes=COALESCE($8,notes),
        share_with_parents=COALESCE($9,share_with_parents),
        occurred_at=COALESCE($10::timestamptz,occurred_at)
      WHERE id=$11 RETURNING *
    `, [food_amount, food_meal, nappy_state, drink_ml, drink_type, sleep_quality,
        duration_minutes, notes, share_with_parents, occurred_at||null, req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /entries/:id — soft delete
router.delete('/entries/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'UPDATE ladn.diary_entries SET deleted_at=now() WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Group daily-diary entry (EyLog parity build, 2026-06-10) ────────────────
// POST /group  — fan-out a meal across all children in a room, one submit.
// Body: { date, meal_type, recipe_id, dish_name, room_id, entries: [{ child_id, amount, refused, notes }] }
// amount: 'none'|'some'|'most'|'all'   refused: bool
// Upserts both diary_entries (entry_type=food) and food_intake_log.
// Idempotent per child+date+meal_type (safe to retry / resync offline queue).
const AMOUNT_PCT = { none: 0, some: 33, most: 66, all: 100 };
const AMOUNT_DIARY = { none: 'some', some: 'some', most: 'most', all: 'all', refused: 'refused' };

router.post('/group', async (req, res) => {
  const {
    date, meal_type, recipe_id, dish_name, entries,
    client_uuid,   // optional idempotency key from offline outbox
  } = req.body;

  if (!entries || !entries.length || !meal_type) {
    return res.status(400).json({ error: 'entries and meal_type required' });
  }

  const db      = getPool();
  const day     = date || new Date().toISOString().slice(0, 10);
  const recipeId = recipe_id ? parseInt(recipe_id, 10) : null;
  let created   = 0;

  try {
    for (const entry of entries) {
      const { child_id, amount, refused, notes } = entry;
      if (!child_id) continue;

      const isRefused    = !!refused;
      const amtKey       = isRefused ? 'refused' : (amount || 'all').toLowerCase();
      const food_amount  = AMOUNT_DIARY[amtKey] || 'some';
      const pct          = isRefused ? null : (AMOUNT_PCT[amtKey] != null ? AMOUNT_PCT[amtKey] : 100);
      const occurred_at  = new Date(`${day}T${new Date().toTimeString().slice(0,5)}:00`).toISOString();
      const entryNotes   = [isRefused ? 'refused' : null, dish_name, notes].filter(Boolean).join(' — ') || null;

      // Upsert diary_entries
      await db.query(`
        INSERT INTO ladn.diary_entries
          (child_id, entry_type, occurred_at, food_amount, food_meal, notes, share_with_parents, staff_id)
        VALUES ($1,'food',$2,$3,$4,$5,true,$6)
        ON CONFLICT DO NOTHING
      `, [child_id, occurred_at, food_amount, meal_type, entryNotes, req.user.id]);

      // Upsert food_intake_log (idempotent on child+date+meal_type)
      await db.query(`
        INSERT INTO ladn.food_intake_log
          (child_id, date, meal_type, recipe_id, amount_eaten_pct, notes, recorded_by, recorded_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT (child_id, date, meal_type) DO UPDATE SET
          recipe_id        = EXCLUDED.recipe_id,
          amount_eaten_pct = EXCLUDED.amount_eaten_pct,
          notes            = EXCLUDED.notes,
          recorded_by      = EXCLUDED.recorded_by,
          recorded_at      = now()
      `, [child_id, day, meal_type, recipeId, pct,
          notes || null, req.user.name || String(req.user.id)]);

      created++;
    }

    res.status(201).json({ created, client_uuid: client_uuid || null });
  } catch (e) {
    console.error('[diary/group]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /group/room-children?room_id=1&date=YYYY-MM-DD — active children in a room for group entry
router.get('/group/room-children', async (req, res) => {
  const { room_id, date } = req.query;
  if (!room_id) return res.status(400).json({ error: 'room_id required' });
  const day = date || new Date().toISOString().slice(0, 10);
  try {
    const db = getPool();
    // Get active children in room, and their food_intake_log entry for this date if it exists
    const { rows } = await db.query(`
      SELECT
        c.id, c.first_name, c.last_name, c.preferred_name, c.photo_url,
        c.allergies, c.dietary_requirements,
        fil.meal_type      AS existing_meal_type,
        fil.amount_eaten_pct AS existing_pct
      FROM ladn.children c
      LEFT JOIN ladn.food_intake_log fil ON fil.child_id = c.id AND fil.date = $2
      WHERE c.room_id = $1
        AND c.is_active = true
      ORDER BY c.first_name, c.last_name
    `, [parseInt(room_id, 10), day]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
