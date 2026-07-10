const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(8000)
    });
  } catch(e) { console.error('telegram allergen alert error:', e.message); }
}

const ALLERGEN_MAP = {
  G:'gluten',C:'crustaceans',E:'eggs',F:'fish',P:'peanuts',S:'soyabeans',
  M:'milk',N:'tree_nuts',CY:'celery',MS:'mustard',SS:'sesame',SL:'sulphites',
  L:'lupin',ML:'molluscs'
};

// ── Public/parent-safe routes (auth still required, handled per-edition) ──
// GET /api/menus/public/week?week_start_date=YYYY-MM-DD&room=preschool
router.get('/public/week', async (req, res) => {
  try {
    const db = getPool();
    let { week_start_date, room } = req.query;
    if (!week_start_date) {
      // Find the current or nearest upcoming Monday
      const { rows } = await db.query(
        `SELECT DISTINCT week_start_date FROM menu_plans
         WHERE week_start_date >= CURRENT_DATE - 7
         ORDER BY week_start_date LIMIT 1`
      );
      week_start_date = rows[0]?.week_start_date || null;
    }
    if (!week_start_date) return res.json({ plans: [], recipes: [] });
    const { rows: plans } = await db.query(`
      SELECT mp.*, mr.name as recipe_name, mr.description, mr.allergens,
             mr.allergen_codes_display, mr.nutrition_per_serving_json,
             mr.age_groups, mr.tags
      FROM menu_plans mp
      LEFT JOIN menu_recipes mr ON mr.id = mp.recipe_id
      WHERE mp.week_start_date = $1 AND mp.room = $2
      ORDER BY mp.day_of_week, mp.meal_type
    `, [week_start_date, room || 'preschool']);
    res.json({ week_start_date, plans });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/menus/public/recipe/:id — recipe detail (no instructions for parents)
router.get('/public/recipe/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, name, description, allergens, allergen_codes_display,
             nutrition_per_serving_json, age_groups, tags
      FROM menu_recipes WHERE id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/menus/public/weeks — parent-safe list of weeks that have a published menu.
// Mirrors /plans/weeks but needs no auth (parents authenticate via CF Access, not a JWT),
// and returns clean 'YYYY-MM-DD' strings to avoid client-side timezone drift.
router.get('/public/weeks', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT DISTINCT to_char(week_start_date, 'YYYY-MM-DD') AS week
      FROM menu_plans
      WHERE recipe_id IS NOT NULL
      ORDER BY week
    `);
    res.json(rows.map(r => r.week));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All remaining routes require authentication
router.use(authenticate);

// ── Recipes ───────────────────────────────────────────────────────────────

// GET /api/menus/recipes
router.get('/recipes', async (req, res) => {
  try {
    const db = getPool();
    const { age_group, allergen, tag, search } = req.query;
    let where = [];
    const params = [];
    if (age_group) { params.push(age_group); where.push(`$${params.length} = ANY(age_groups)`); }
    if (allergen) { params.push(allergen); where.push(`$${params.length} != ALL(allergens)`); }
    if (tag) { params.push(tag); where.push(`$${params.length} = ANY(tags)`); }
    if (search) { params.push('%' + search + '%'); where.push(`name ILIKE $${params.length}`); }
    const sql = `SELECT * FROM menu_recipes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name LIMIT 200`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/menus/recipes/:id
router.get('/recipes/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM menu_recipes WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/menus/recipes
router.post('/recipes', async (req, res) => {
  if (!['manager','deputy_manager','admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  const {
    name, description, age_groups, serves_n, prep_minutes, cook_minutes,
    instructions, allergen_codes_display, tags, nutrition_per_serving_json
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 120);
  const allergens = (allergen_codes_display || []).map(c => ALLERGEN_MAP[c]).filter(Boolean);
  try {
    const { rows } = await getPool().query(`
      INSERT INTO menu_recipes
        (slug,name,description,age_groups,serves_n,prep_minutes,cook_minutes,
         instructions,allergens,allergen_codes_display,tags,
         nutrition_per_serving_json,nutrition_source,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'chef_provided',$13) RETURNING *
    `, [slug,name,description,age_groups||['toddler','preschool'],
        serves_n||22,prep_minutes||null,cook_minutes||null,
        instructions||null,allergens,allergen_codes_display||[],
        tags||[],JSON.stringify(nutrition_per_serving_json||{}),req.user.name]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/menus/recipes/:id
router.put('/recipes/:id', async (req, res) => {
  if (!['manager','deputy_manager','admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  const {
    name, description, age_groups, serves_n, prep_minutes, cook_minutes,
    instructions, allergen_codes_display, tags, nutrition_per_serving_json,
    is_published
  } = req.body;
  const allergens = (allergen_codes_display || []).map(c => ALLERGEN_MAP[c]).filter(Boolean);
  try {
    const { rows } = await getPool().query(`
      UPDATE menu_recipes SET
        name=COALESCE($1,name), description=COALESCE($2,description),
        age_groups=COALESCE($3,age_groups), serves_n=COALESCE($4,serves_n),
        prep_minutes=COALESCE($5,prep_minutes), cook_minutes=COALESCE($6,cook_minutes),
        instructions=COALESCE($7,instructions),
        allergens=$8, allergen_codes_display=COALESCE($9,allergen_codes_display),
        tags=COALESCE($10,tags),
        nutrition_per_serving_json=COALESCE($11,nutrition_per_serving_json),
        is_published=COALESCE($12,is_published), updated_at=now()
      WHERE id=$13 RETURNING *
    `, [name,description,age_groups,serves_n,prep_minutes,cook_minutes,
        instructions,allergens,allergen_codes_display,tags,
        nutrition_per_serving_json ? JSON.stringify(nutrition_per_serving_json) : null,
        is_published,req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Menu Plans ────────────────────────────────────────────────────────────

// GET /api/menus/plans?week_start_date=YYYY-MM-DD&room=preschool
router.get('/plans', async (req, res) => {
  try {
    const db = getPool();
    const { week_start_date, room } = req.query;
    if (!week_start_date) return res.status(400).json({ error: 'week_start_date required' });
    const { rows } = await db.query(`
      SELECT mp.*, mr.name as recipe_name, mr.allergens,
             mr.allergen_codes_display, mr.nutrition_per_serving_json
      FROM menu_plans mp
      LEFT JOIN menu_recipes mr ON mr.id = mp.recipe_id
      WHERE mp.week_start_date = $1 AND ($2::text IS NULL OR mp.room = $2)
      ORDER BY mp.room, mp.day_of_week, mp.meal_type
    `, [week_start_date, room || null]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/menus/plans/weeks — list available weeks
router.get('/plans/weeks', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT DISTINCT week_start_date FROM menu_plans
      ORDER BY week_start_date
    `);
    res.json(rows.map(r => r.week_start_date));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/menus/plans/:id — update a plan slot
router.put('/plans/:id', async (req, res) => {
  if (!['manager','deputy_manager','admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  const { recipe_id, status, notes, override_serves_n } = req.body;
  try {
    const db = getPool();
    let updates = [];
    const params = [];
    if (recipe_id !== undefined) { params.push(recipe_id); updates.push(`recipe_id=$${params.length}`); }
    if (notes !== undefined)     { params.push(notes);     updates.push(`notes=$${params.length}`); }
    if (override_serves_n !== undefined) { params.push(override_serves_n); updates.push(`override_serves_n=$${params.length}`); }
    if (status === 'approved') {
      updates.push(`status='approved', approved_by='${req.user.name}', approved_at=now()`);
    } else if (status !== undefined) {
      params.push(status); updates.push(`status=$${params.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push('updated_at=now()');
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE menu_plans SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/menus/plans — create a plan slot
router.post('/plans', async (req, res) => {
  if (!['manager','deputy_manager','admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  const { week_start_date, room, day_of_week, meal_type, recipe_id, notes } = req.body;
  if (!week_start_date || day_of_week === undefined || !meal_type)
    return res.status(400).json({ error: 'week_start_date, day_of_week, meal_type required' });
  try {
    const { rows } = await getPool().query(`
      INSERT INTO menu_plans (week_start_date,room,day_of_week,meal_type,recipe_id,notes)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (week_start_date,room,day_of_week,meal_type) DO UPDATE
        SET recipe_id=EXCLUDED.recipe_id, notes=EXCLUDED.notes, updated_at=now()
      RETURNING *
    `, [week_start_date, room||'preschool', day_of_week, meal_type, recipe_id||null, notes||null]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/menus/plans/:id/serve — chef marks as served
router.post('/plans/:id/serve', async (req, res) => {
  const { override_serves_n } = req.body;
  try {
    const { rows } = await getPool().query(`
      UPDATE menu_plans SET status='served', served_at=now(),
        override_serves_n=COALESCE($1,override_serves_n), updated_at=now()
      WHERE id=$2 RETURNING *
    `, [override_serves_n||null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Today's menu (chef view) ──────────────────────────────────────────────

// GET /api/menus/today?room=preschool
router.get('/today', async (req, res) => {
  try {
    const db = getPool();
    const room = req.query.room || 'preschool';
    const today = new Date();
    const dow = today.getDay(); // 0=Sun, 1=Mon...
    if (dow === 0 || dow === 6) return res.json({ plans: [], message: 'Weekend — no menu' });

    // Find the Monday of the current week
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dow - 1));
    const mondayStr = monday.toISOString().split('T')[0];

    const { rows: plans } = await db.query(`
      SELECT mp.*, mr.name as recipe_name, mr.description, mr.instructions,
             mr.allergens, mr.allergen_codes_display, mr.nutrition_per_serving_json,
             mr.serves_n, mr.prep_minutes, mr.cook_minutes, mr.ingredients_json
      FROM menu_plans mp
      LEFT JOIN menu_recipes mr ON mr.id = mp.recipe_id
      WHERE mp.week_start_date=$1 AND mp.day_of_week=$2 AND mp.room=$3
      ORDER BY mp.meal_type
    `, [mondayStr, dow, room]);

    // Get children with allergens currently attending
    const { rows: children } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.allergens, c.photo_url
      FROM children c
      WHERE c.allergens IS NOT NULL AND array_length(c.allergens, 1) > 0
        AND c.is_active = true
      ORDER BY c.first_name
    `);

    res.json({ plans, allergen_children: children, date: today.toISOString().split('T')[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Food Intake Log ───────────────────────────────────────────────────────

// GET /api/menus/food-intake?child_id=&date=
router.get('/food-intake', async (req, res) => {
  try {
    const db = getPool();
    const { child_id, date } = req.query;
    const params = [];
    const where = [];
    if (child_id) { params.push(parseInt(child_id)); where.push(`f.child_id=$${params.length}`); }
    if (date)     { params.push(date); where.push(`f.date=$${params.length}`); }
    const { rows } = await db.query(`
      SELECT f.*, mr.name as recipe_name, mr.allergens as recipe_allergens,
             c.first_name, c.last_name
      FROM food_intake_log f
      LEFT JOIN menu_recipes mr ON mr.id = f.recipe_id
      LEFT JOIN children c ON c.id = f.child_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY f.recorded_at DESC LIMIT 500
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/menus/food-intake
router.post('/food-intake', async (req, res) => {
  const { child_id, date, meal_type, recipe_id, amount_eaten_pct, notes } = req.body;
  if (!child_id || !meal_type) return res.status(400).json({ error: 'child_id and meal_type required' });
  try {
    const db = getPool();

    // Allergen warning: check if child has allergen matching recipe
    let allergenWarning = null;
    if (recipe_id && amount_eaten_pct > 0) {
      const { rows: childRow } = await db.query(
        'SELECT allergens, first_name FROM children WHERE id=$1', [child_id]);
      const { rows: recipeRow } = await db.query(
        'SELECT allergens, name FROM menu_recipes WHERE id=$1', [recipe_id]);
      if (childRow[0]?.allergens && recipeRow[0]?.allergens) {
        const overlap = childRow[0].allergens.filter(a => recipeRow[0].allergens.includes(a));
        if (overlap.length) {
          allergenWarning = { child: childRow[0].first_name, recipe: recipeRow[0].name, allergens: overlap };
          sendTelegram(`🚨 *Allergen Alert*\n${childRow[0].first_name} has eaten *${recipeRow[0].name}* which contains flagged allergen(s): *${overlap.join(', ')}*\nAmount: ${amount_eaten_pct}%\nLogged by: ${req.user?.name || 'staff'}\nPlease check child records immediately.`);
        }
      }
    }

    const { rows } = await db.query(`
      INSERT INTO food_intake_log (child_id,date,meal_type,recipe_id,amount_eaten_pct,notes,recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING RETURNING *
    `, [child_id, date||new Date().toISOString().split('T')[0], meal_type,
        recipe_id||null, amount_eaten_pct||0, notes||null, req.user.name]);
    res.status(201).json({ ...(rows[0]||{}), allergen_warning: allergenWarning });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Shopping lists ────────────────────────────────────────────────────────

// GET /api/menus/shopping-lists
router.get('/shopping-lists', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM shopping_lists ORDER BY week_start_date DESC LIMIT 20');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/menus/shopping-lists/generate?week_start_date=&room=
router.post('/shopping-lists/generate', async (req, res) => {
  if (!['manager','deputy_manager','admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  const { week_start_date, room } = req.body;
  if (!week_start_date) return res.status(400).json({ error: 'week_start_date required' });
  try {
    const db = getPool();
    const { rows: plans } = await db.query(`
      SELECT mp.*, mr.ingredients_json, mr.allergens,
             COALESCE(mp.override_serves_n, mr.serves_n) as final_serves
      FROM menu_plans mp
      LEFT JOIN menu_recipes mr ON mr.id = mp.recipe_id
      WHERE mp.week_start_date=$1 AND mp.room=$2
    `, [week_start_date, room||'preschool']);

    // Aggregate ingredients across all plans
    const ingredientTotals = {};
    for (const plan of plans) {
      if (!plan.ingredients_json) continue;
      const ings = Array.isArray(plan.ingredients_json) ? plan.ingredients_json : JSON.parse(plan.ingredients_json);
      for (const ing of ings) {
        const k = ing.ingredient_id || ing.name;
        if (!ingredientTotals[k]) ingredientTotals[k] = { ...ing, total_quantity: 0 };
        ingredientTotals[k].total_quantity += (ing.quantity || 0) * (plan.final_serves / 22);
      }
    }

    const items = Object.values(ingredientTotals);
    const { rows: sl } = await db.query(`
      INSERT INTO shopping_lists (week_start_date, room, items_json, status, ordered_by)
      VALUES ($1,$2,$3,'pending',$4) RETURNING *
    `, [week_start_date, room||'preschool', JSON.stringify(items), req.user.name]);

    res.status(201).json(sl[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/menus/shopping-list/:id/sainsburys-cart — for future Chrome extension
router.get('/shopping-list/:id/sainsburys-cart', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM shopping_lists WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const list = rows[0];
    const items = list.items_json || [];

    // Return Sainsbury's cart format for Chrome extension
    const cartItems = items.map(item => ({
      sku: item.sainsburys_sku || null,
      name: item.name || item.ingredient_id,
      quantity: Math.ceil(item.total_quantity / 1000) || 1,
      unit: item.unit,
      est_price_pence: item.est_price_pence || null,
      sainsburys_url: item.sainsburys_url || null
    })).filter(i => i.sku);

    res.json({
      shopping_list_id: list.id,
      week_start_date: list.week_start_date,
      room: list.room,
      generated_at: list.generated_at,
      cart_items: cartItems,
      items_without_sku: items.length - cartItems.length
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Ingredients ───────────────────────────────────────────────────────────

// GET /api/menus/ingredients
router.get('/ingredients', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM ingredients ORDER BY name LIMIT 200');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/menus/ingredients/:id
router.put('/ingredients/:id', async (req, res) => {
  if (!['manager','deputy_manager','admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  const { sainsburys_sku, sainsburys_url, sainsburys_last_price_pence, notes } = req.body;
  try {
    const { rows } = await getPool().query(`
      UPDATE ingredients SET
        sainsburys_sku=COALESCE($1,sainsburys_sku),
        sainsburys_url=COALESCE($2,sainsburys_url),
        sainsburys_last_price_pence=COALESCE($3,sainsburys_last_price_pence),
        sainsburys_last_check=CASE WHEN $3 IS NOT NULL THEN now() ELSE sainsburys_last_check END,
        notes=COALESCE($4,notes), updated_at=now()
      WHERE id=$5 RETURNING *
    `, [sainsburys_sku||null, sainsburys_url||null, sainsburys_last_price_pence||null, notes||null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Children allergen management ──────────────────────────────────────────

// GET /api/menus/children-allergens
router.get('/children-allergens', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, first_name, last_name, allergens, allergen_notes, dietary_requirements, photo_url
      FROM children WHERE is_active=true ORDER BY first_name
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/menus/children/:id/allergens
router.put('/children/:id/allergens', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  const { allergens, allergen_notes, dietary_requirements } = req.body;
  try {
    const { rows } = await getPool().query(`
      UPDATE children SET allergens=$1, allergen_notes=$2, dietary_requirements=$3
      WHERE id=$4 RETURNING id, first_name, allergens, allergen_notes, dietary_requirements
    `, [allergens||[], allergen_notes||null, dietary_requirements||null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
