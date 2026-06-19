const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /today?room=baby_room|pre_school&meal_type=breakfast|lunch|tea|snack
// Returns today's dish from menu_plans → menu_recipes.
// Falls back to menu_items (legacy schema) if no plan found.
router.get('/today', async (req, res) => {
  const { room, meal_type } = req.query;
  const db  = getPool();

  // Derive ISO week-start (Monday) and 1-indexed day-of-week for today
  const now       = new Date();
  const dow       = now.getDay();            // 0=Sun
  const pgDow     = dow === 0 ? 7 : dow;    // 1=Mon … 7=Sun
  const monday    = new Date(now);
  const diff      = now.getDay() === 0 ? -6 : 1 - now.getDay();
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  const weekStart = monday.toISOString().slice(0, 10);

  try {
    // Build query — room and meal_type are both optional filters
    const params = [weekStart, pgDow];
    let extra = '';
    if (room)      { params.push(room);      extra += ` AND mp.room = $${params.length}`; }
    if (meal_type) { params.push(meal_type); extra += ` AND mp.meal_type = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        mp.id            AS plan_id,
        mp.meal_type,
        mp.room,
        mp.recipe_id,
        mr.name          AS dish_name,
        mr.description   AS dish_description,
        mr.allergens,
        mr.allergen_codes_display
      FROM ladn.menu_plans mp
      LEFT JOIN ladn.menu_recipes mr ON mr.id = mp.recipe_id
      WHERE mp.week_start_date = $1
        AND mp.day_of_week     = $2
        ${extra}
      ORDER BY CASE mp.meal_type
        WHEN 'breakfast' THEN 1
        WHEN 'snack'     THEN 2
        WHEN 'lunch'     THEN 3
        WHEN 'tea'       THEN 4
        ELSE 5 END
    `, params);

    if (!rows.length && meal_type) {
      // Soft fallback: query for the same meal across any room so the UI gets *something*
      const { rows: fallback } = await db.query(`
        SELECT mp.meal_type, mp.room, mp.recipe_id,
               mr.name AS dish_name, mr.description AS dish_description,
               mr.allergens, mr.allergen_codes_display
        FROM ladn.menu_plans mp
        LEFT JOIN ladn.menu_recipes mr ON mr.id = mp.recipe_id
        WHERE mp.week_start_date = $1 AND mp.day_of_week = $2 AND mp.meal_type = $3
        LIMIT 1
      `, [weekStart, pgDow, meal_type]);
      return res.json(fallback);
    }

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
