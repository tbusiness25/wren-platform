const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const { operationalChildFilter, ensureEnrolmentMiddleware } = require('../utils/enrolment'); // b96
const { getMenuForDate } = require('../lib/menu-rotation'); // b171 (2026-07-28) — rotation-aware menu weeks
router.use(ensureEnrolmentMiddleware(getPool));

// ── Telegram helper (kitchen alerts) ─────────────────────────────────────────
// login-20261023: through the one Telegram sender (src/lib/notifications.js) — same text and format,
// plus its dev/MAIL_DISABLED guard, which this private copy never had.
async function sendTelegram(text) { return require('../lib/notifications').sendTelegramNow({ text, parse_mode: 'Markdown' }); }

// ── PUBLIC webhook (no auth — mounted before authenticate, like Dahua) ───────
// POST /api/kitchen/sensor-log  — Sonoff TH temperature/humidity ingest.
// Body: { location:'fridge'|'freezer', reading_c, sensor_id?, humidity_pct?, source? }
// b331 (2026-09-15): the shared token is now REQUIRED. Header x-kitchen-token must
// match env KITCHEN_SENSOR_TOKEN (or, when that is unset, settings.kitchen_sensor_token).
// With neither configured, every write is refused (fail closed) — the 2026-09-15
// audit found this endpoint accepted readings from anyone. Staff logging a reading
// by hand now use the authenticated POST /api/kitchen/manual-temp (below).
// Home Assistant setup: wren-docs/kitchen/kitchen-sensor-token.md
async function _sensorToken() {
  if (process.env.KITCHEN_SENSOR_TOKEN) return String(process.env.KITCHEN_SENSOR_TOKEN).trim();
  try {
    const { rows } = await getPool().query("SELECT value FROM settings WHERE key = 'kitchen_sensor_token'");
    return rows[0] && rows[0].value ? String(rows[0].value).trim() : '';
  } catch { return ''; }
}
function _sameToken(given, expected) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
  return a.length > 0 && a.length === b.length && require('crypto').timingSafeEqual(a, b);
}
router.post('/sensor-log', express.json(), async (req, res) => {
  const gate = await _sensorToken();
  if (!gate) {
    return res.status(401).json({ error: 'sensor logging is switched off until KITCHEN_SENSOR_TOKEN is set' });
  }
  if (!_sameToken(req.headers['x-kitchen-token'], gate)) {
    return res.status(401).json({ error: 'bad token' });
  }
  const { location, reading_c, sensor_id, humidity_pct, source } = req.body || {};
  if (!location || reading_c === undefined || reading_c === null || isNaN(Number(reading_c))) {
    return res.status(400).json({ error: 'location and numeric reading_c required' });
  }
  if (Number(reading_c) < -60 || Number(reading_c) > 100) {   // b331 — not a fridge or a freezer
    return res.status(400).json({ error: 'reading_c out of range' });
  }
  try {
    const db = getPool();
    const { rows: th } = await db.query(
      'SELECT label, min_c, max_c FROM kitchen_temp_thresholds WHERE location=$1', [location]);
    const t = th[0];
    const r = Number(reading_c);
    const oor = t ? (r < Number(t.min_c) || r > Number(t.max_c)) : false;

    // Edge-trigger alerting: only alert when crossing INTO out-of-range
    // (avoids spamming on every periodic reading while still excursing).
    let prevOor = false;
    const { rows: prev } = await db.query(
      'SELECT out_of_range FROM kitchen_sensor_readings WHERE location=$1 ORDER BY recorded_at DESC LIMIT 1', [location]);
    if (prev[0]) prevOor = prev[0].out_of_range;

    const { rows: ins } = await db.query(`
      INSERT INTO kitchen_sensor_readings (location, sensor_id, reading_c, humidity_pct, out_of_range, source)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, recorded_at
    `, [location, sensor_id || null, r, humidity_pct ?? null, oor, source || 'sonoff']);

    if (oor && !prevOor && t) {
      await sendTelegram(
        `🚨 *Kitchen temp out of range*\n${t.label}: *${r}°C* (safe ${t.min_c}–${t.max_c}°C)\n` +
        `Sensor: ${sensor_id || 'n/a'}\nRecorded: ${ins[0].recorded_at}\nCheck the appliance.`);
    }
    res.status(201).json({ id: ins[0].id, location, reading_c: r, out_of_range: oor, alerted: !!(oor && !prevOor && t) });
  } catch (e) { console.error('[kitchen/sensor-log]', e.message); res.status(500).json({ error: e.message }); }
});

router.use(authenticate);

// ── Kitchen access gate (2026-06-22) — the kitchen module is locked behind the
// permissions matrix. Managers pass automatically; everyone else needs the
// 'kitchen.access' capability (grant per-staff in System → Permissions).
// NB: the public /sensor-log webhook above is mounted before authenticate and
// is intentionally NOT affected. The all-staff "what's for lunch" view uses
// /api/menu, not /api/kitchen, so it is unaffected too.
const { hasCapability } = require('../lib/capabilities');
router.use(async (req, res, next) => {
  // Cook/chef role always has kitchen access (their only portal surface).
  // 'chef' added 2026-07-28 as an alias of 'cook' — same restricted surface.
  if (req.user && (req.user.role === 'cook' || req.user.role === 'chef')) return next();
  try {
    if (await hasCapability(req.user, 'kitchen.access')) return next();
  } catch (e) { /* fall through to deny (fail closed) */ }
  return res.status(403).json({ error: 'Kitchen access not permitted', need: 'kitchen.access' });
});

// GET /current — get current or latest active menu group with items.
// b171 (2026-07-28): now rotation-aware — resolves the active menu_group_weeks
// week for ?date= (default today) via src/lib/menu-rotation.js, and optionally
// scopes to ?room= for room/age-group variations. Response keeps the original
// { group, items } shape (plus week_number/week) so existing callers still work.
router.get('/current', async (req, res) => {
  try {
    const db = getPool();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const result = await getMenuForDate(db, date, req.query.room || null);
    if (!result.group) return res.json({ group: null, items: [] });
    res.json({ group: result.group, week_number: result.week_number, week: result.week, items: result.items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /groups — all menu groups
router.get('/groups', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM menu_groups ORDER BY date_from DESC LIMIT 20');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /groups — create new menu week
router.post('/groups', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) return res.status(403).json({ error: 'Manager only' });
  const { name, date_from, date_to } = req.body;
  if (!name || !date_from || !date_to) return res.status(400).json({ error: 'name, date_from, date_to required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO menu_groups (name, date_from, date_to, is_active) VALUES ($1,$2,$3,true) RETURNING *`,
      [name, date_from, date_to]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /items/:id — update a menu item
router.put('/items/:id', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) return res.status(403).json({ error: 'Manager only' });
  const { description, allergens } = req.body;
  try {
    const db = getPool();
    const updates = [], vals = [];
    if (description !== undefined) { vals.push(description); updates.push(`description=$${vals.length}`); }
    if (allergens !== undefined) { vals.push(allergens); updates.push(`allergens=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await db.query(`UPDATE menu_items SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /items — create menu item
router.post('/items', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) return res.status(403).json({ error: 'Manager only' });
  const { menu_group_id, day_of_week, meal_type, description, allergens } = req.body;
  if (!menu_group_id || day_of_week === undefined || !meal_type) return res.status(400).json({ error: 'menu_group_id, day_of_week, meal_type required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO menu_items (menu_group_id, day_of_week, meal_type, description, allergens)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [menu_group_id, day_of_week, meal_type, description||'', allergens||[]]
    );
    res.status(201).json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /allergen-summary — which children have which allergens
//
// b314 (2026-09-10): there are TWO boxes in Wren a person can type a food
// allergy into — Details → "Allergies" (children.allergies) and All About Me →
// "Food Allergies" (child_about_me.food_allergies), and the parents portal
// writes the second one as well (PUT /api/parents/child/:id/about-me). This
// endpoint read only the first, so an allergy entered in All About Me — by a
// practitioner or by the family — never reached the chef. On production at the
// time of the audit that was one live child. It reads both now, and the WHERE
// admits a child who has only the About-Me one.
router.get('/allergen-summary', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name||' '||c.last_name as name, c.room_id, r.name as room_name,
             NULLIF(TRIM(CONCAT_WS(' · ',
               NULLIF(NULLIF(TRIM(c.allergies), ''), '{}'),
               NULLIF(TRIM(cam.food_allergies), ''))), '') AS allergies,
             c.dietary_requirements,
             NULLIF(NULLIF(TRIM(c.allergies), ''), '{}')   AS allergies_clinical,
             NULLIF(TRIM(cam.food_allergies), '')          AS allergies_about_me
      FROM children c
      LEFT JOIN rooms r ON r.id=c.room_id
      LEFT JOIN child_about_me cam ON cam.child_id = c.id
      WHERE ${operationalChildFilter('c')}
        AND ( (c.allergies IS NOT NULL AND c.allergies != '' AND c.allergies != '{}')
           OR (cam.food_allergies IS NOT NULL AND TRIM(cam.food_allergies) != '') )
      ORDER BY c.first_name, c.last_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SENSORS (authed) ─────────────────────────────────────────────────────────
// GET /sensors/latest — latest reading per location + threshold + status
router.get('/sensors/latest', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT DISTINCT ON (s.location)
        s.location, t.label, s.reading_c, s.humidity_pct, s.out_of_range, s.recorded_at,
        t.min_c, t.max_c
      FROM kitchen_sensor_readings s
      LEFT JOIN kitchen_temp_thresholds t ON t.location = s.location
      ORDER BY s.location, s.recorded_at DESC
    `);
    const { rows: thresholds } = await db.query('SELECT * FROM kitchen_temp_thresholds ORDER BY location');
    res.json({ latest: rows, thresholds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /sensors/history?location=fridge&hours=48
router.get('/sensors/history', async (req, res) => {
  const { location } = req.query;
  const hours = Math.min(parseInt(req.query.hours, 10) || 48, 720);
  try {
    const { rows } = await getPool().query(`
      SELECT location, reading_c, humidity_pct, out_of_range, recorded_at
      FROM kitchen_sensor_readings
      WHERE ($1::text IS NULL OR location=$1) AND recorded_at > now() - ($2 || ' hours')::interval
      ORDER BY recorded_at DESC LIMIT 500
    `, [location || null, String(hours)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SFBB (Safer Food Better Business) daily checks ───────────────────────────
const SFBB_CHECKLIST = {
  opening: [
    { section: 'Temperatures', items: ['Fridge temperature recorded (°C)', 'Freezer temperature recorded (°C)'] },
    { section: 'Stock',        items: ['All food within use-by / best-before dates', 'Deliveries checked & stored promptly'] },
    { section: 'Cleanliness',  items: ['Food prep surfaces clean & sanitised', 'Hand-wash basin stocked (soap & towels)', 'Probe thermometer working & sanitised'] },
    { section: 'Staff health', items: ['All kitchen staff fit to work (no sickness/diarrhoea in last 48h)'] }
  ],
  closing: [
    { section: 'Temperatures',  items: ['Fridge temperature recorded (°C)', 'Freezer temperature recorded (°C)'] },
    { section: 'Food storage',  items: ['Hot food cooled within 90 min & refrigerated', 'Leftovers labelled & dated', 'Allergen ingredients stored separately'] },
    { section: 'Cleaning down', items: ['Surfaces cleaned & sanitised', 'Floors swept & mopped', 'Bins emptied & sanitised', 'Equipment cleaned & switched off', 'Probe thermometer cleaned'] }
  ]
};
// b331 (2026-09-15): the chef's one-question-per-screen checks add a daily pest check
// and "out-of-date food thrown away". Appended here (never renamed or removed) so
// the Roost SFBB Diary tab shows her answers under the same section/item strings.
require('../lib/kitchen-simple').extendLegacyChecklist(SFBB_CHECKLIST);

// GET /sfbb?date=YYYY-MM-DD&shift=opening|closing — template merged with saved values
router.get('/sfbb', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const shift = (req.query.shift === 'closing') ? 'closing' : 'opening';
  try {
    const { rows: saved } = await getPool().query(
      'SELECT section, item, checked, value_text, notes, recorded_by, recorded_at FROM sfbb_records WHERE date=$1 AND shift=$2',
      [date, shift]);
    const byKey = {};
    for (const r of saved) byKey[`${r.section}||${r.item}`] = r;
    const sections = SFBB_CHECKLIST[shift].map(s => ({
      section: s.section,
      items: s.items.map(item => {
        const rec = byKey[`${s.section}||${item}`] || {};
        return { item, checked: rec.checked || false, value_text: rec.value_text || '', notes: rec.notes || '',
                 recorded_by: rec.recorded_by || null, recorded_at: rec.recorded_at || null };
      })
    }));
    res.json({ date, shift, sections });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /sfbb — { date, shift, items:[{section,item,checked,value_text,notes}] }
router.post('/sfbb', async (req, res) => {
  const { date, shift, items } = req.body;
  if (!date || !['opening', 'closing'].includes(shift) || !Array.isArray(items))
    return res.status(400).json({ error: 'date, shift(opening|closing), items[] required' });
  try {
    const db = getPool();
    let saved = 0;
    for (const it of items) {
      if (!it.section || !it.item) continue;
      await db.query(`
        INSERT INTO sfbb_records (date, shift, section, item, checked, value_text, notes, recorded_by, recorded_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
        ON CONFLICT (date, shift, section, item) DO UPDATE SET
          checked = EXCLUDED.checked, value_text = EXCLUDED.value_text,
          notes = EXCLUDED.notes, recorded_by = EXCLUDED.recorded_by, recorded_at = now()
      `, [date, shift, it.section, it.item, !!it.checked, it.value_text || null, it.notes || null,
          req.user.name || String(req.user.id)]);
      saved++;
    }
    res.status(201).json({ saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cleaning schedule ────────────────────────────────────────────────────────
// GET /cleaning?date=YYYY-MM-DD — tasks + done-status for the day
router.get('/cleaning', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await getPool().query(`
      SELECT t.id, t.area, t.frequency, t.sort_order,
             l.done, l.notes, l.recorded_by, l.recorded_at
      FROM kitchen_cleaning_tasks t
      LEFT JOIN kitchen_cleaning_log l ON l.task_id = t.id AND l.date = $1
      WHERE t.is_active = true
      ORDER BY CASE t.frequency WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END, t.sort_order
    `, [date]);
    res.json({ date, tasks: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /cleaning/log — { task_id, date, done, notes }
router.post('/cleaning/log', async (req, res) => {
  const { task_id, date, done, notes } = req.body;
  if (!task_id || !date) return res.status(400).json({ error: 'task_id, date required' });
  try {
    const { rows } = await getPool().query(`
      INSERT INTO kitchen_cleaning_log (task_id, date, done, notes, recorded_by, recorded_at)
      VALUES ($1,$2,$3,$4,$5,now())
      ON CONFLICT (task_id, date) DO UPDATE SET
        done = EXCLUDED.done, notes = EXCLUDED.notes, recorded_by = EXCLUDED.recorded_by, recorded_at = now()
      RETURNING *
    `, [task_id, date, done !== false, notes || null, req.user.name || String(req.user.id)]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Allergy day-sheet ────────────────────────────────────────────────────────
// GET /day-sheet?date=YYYY-MM-DD — present children with allergies, absent-sick,
//   today's menu allergens, and conflicts (allergen letters overlapping menu).
router.get('/day-sheet', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const db = getPool();
    // Present children (attendance row not marked absent) with their allergy info.
    // b268: food_texture comes along too — "pureed / lumpy / whole" is a choking-risk
    // instruction the person plating the food needs, not a profile detail.
    const { rows: present } = await db.query(`
      SELECT c.id, c.first_name||' '||c.last_name AS name, c.room_id, r.name AS room,
             NULLIF(TRIM(CONCAT_WS(' \u00b7 ',
               NULLIF(NULLIF(TRIM(c.allergies), ''), '{}'),
               NULLIF(TRIM(cam.food_allergies), ''))), '') AS allergies,
             c.dietary_requirements, cam.food_texture
      FROM attendance a
      JOIN children c ON c.id = a.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN child_about_me cam ON cam.child_id = c.id
      WHERE a.date = $1 AND COALESCE(a.absent,false) = false
      ORDER BY r.name, c.first_name
    `, [date]);

    const present_with_allergies = present.filter(c =>
      (c.allergies && c.allergies.trim() && c.allergies.trim() !== '{}') ||
      (c.dietary_requirements && c.dietary_requirements.trim() && c.dietary_requirements.trim() !== '{}'));

    // b268: separate list — a child can need their food a certain texture without
    // having a single allergy, and the chef still has to know before serving.
    const present_with_texture = present
      .filter(c => c.food_texture && String(c.food_texture).trim())
      .map(c => ({ id: c.id, name: c.name, room: c.room, food_texture: String(c.food_texture).trim() }));

    // Absent-sick
    const { rows: absent_sick } = await db.query(`
      SELECT c.id, c.first_name||' '||c.last_name AS name, a.absence_reason
      FROM attendance a JOIN children c ON c.id = a.child_id
      WHERE a.date = $1 AND a.absent = true
        AND (a.absence_reason ILIKE '%sick%' OR a.absence_reason ILIKE '%ill%' OR a.absence_reason ILIKE '%unwell%')
      ORDER BY c.first_name
    `, [date]);

    // Today's menu allergens — b171 (2026-07-28): rotation-aware (active
    // menu_group_weeks week for `date`), via src/lib/menu-rotation.js.
    const dow = new Date(date + 'T00:00:00').getDay();
    const { items: weekItems } = await getMenuForDate(db, date, null);
    const menuRows = weekItems
      .filter(mi => mi.day_of_week === dow)
      .map(mi => ({ meal_type: mi.meal_type, description: mi.description, allergens: mi.allergens }));
    const menuAllergens = new Set();
    for (const m of menuRows) (m.allergens || []).forEach(a => menuAllergens.add(String(a).toUpperCase()));

    // Conflicts: child allergy text contains a code/word matching today's menu allergens
    const conflicts = present_with_allergies.filter(c => {
      const txt = `${c.allergies || ''} ${c.dietary_requirements || ''}`.toUpperCase();
      return [...menuAllergens].some(code => txt.includes(code));
    }).map(c => ({ id: c.id, name: c.name, room: c.room, allergies: c.allergies }));

    res.json({
      date,
      present_count: present.length,
      present_with_allergies,
      present_with_texture,          // b268 — solid-food stage (choking risk)
      absent_sick,
      menu_today: menuRows,
      menu_allergens: [...menuAllergens],
      conflicts
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cooking temperatures ──
router.get('/cooking-temps', authenticate, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM kitchen_cooking_temps WHERE date=$1 ORDER BY logged_at DESC', [date]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cooking-temps', authenticate, express.json(), async (req, res) => {
  const { food_name, temp_c, notes } = req.body || {};
  if (!food_name || temp_c == null) return res.status(400).json({ error: 'food_name + temp_c required' });
  try {
    const { rows } = await getPool().query(
      'INSERT INTO kitchen_cooking_temps (food_name, temp_c, notes, logged_by_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [food_name, Number(temp_c), notes || null, req.user?.id || null]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Kitchen notes ──
router.get('/notes', authenticate, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM kitchen_notes WHERE date=$1 ORDER BY updated_at DESC', [date]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/notes', authenticate, express.json(), async (req, res) => {
  const { date, content } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO kitchen_notes (date, content, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (date) DO UPDATE SET content=EXCLUDED.content, updated_at=now()
       RETURNING *`,
      [date, content || null]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chef allergy × attendance briefing (2026-07-01) ──────────────────────────
// Cross-references the children SIGNED IN today (attendance.sign_in_time NOT NULL)
// against their allergy / dietary records + today's menu allergens. Powers the
// chef briefing card on the kitchen page and the optional Telegram push. Keys on
// actual sign-in (not merely "not absent") so the chef only sees children who are
// physically present — the register seeds each morning, staff tap to sign in.
async function buildAllergyBriefing(db, date) {
  const { rows: signedIn } = await db.query(`
    SELECT c.id, c.first_name||' '||c.last_name AS name, c.room_id, r.name AS room,
           c.allergies, c.dietary_requirements, c.allergens, c.allergen_notes,
           cam.food_texture,
           -- b314: All About Me → "Food Allergies" is a second box the same
           -- allergy can be typed into, and the parents portal writes it too.
           -- It was invisible to the chef until now.
           NULLIF(TRIM(cam.food_allergies), '') AS food_allergies_about_me,
           a.sign_in_time
    FROM attendance a
    JOIN children c ON c.id = a.child_id
    LEFT JOIN rooms r ON r.id = c.room_id
    LEFT JOIN child_about_me cam ON cam.child_id = c.id
    WHERE a.date = $1 AND a.sign_in_time IS NOT NULL AND a.sign_out_time IS NULL
      AND COALESCE(a.absent,false) = false
    ORDER BY r.name, c.first_name
  `, [date]);

  const hasFlag = c =>
    (c.allergies && String(c.allergies).trim() && String(c.allergies).trim() !== '{}') ||
    (c.dietary_requirements && String(c.dietary_requirements).trim() && String(c.dietary_requirements).trim() !== '{}') ||
    (Array.isArray(c.allergens) && c.allergens.length) ||
    (c.allergen_notes && String(c.allergen_notes).trim()) ||
    (c.food_allergies_about_me && String(c.food_allergies_about_me).trim());   // b314

  // b314: the chef reads one line per child, so the two allergy boxes are
  // joined into it rather than added as a field nobody's card renders.
  const allergyText = c => [
    (c.allergies || '').trim().replace(/^\{\}$/, ''),
    (c.food_allergies_about_me || '').trim(),
  ].filter(Boolean).join(' \u00b7 ');

  const flagged = signedIn.filter(hasFlag).map(c => ({
    id: c.id, name: c.name, room: c.room,
    allergies: allergyText(c), dietary_requirements: c.dietary_requirements || '',
    allergens: Array.isArray(c.allergens) ? c.allergens : [],
    allergen_notes: c.allergen_notes || '', sign_in_time: c.sign_in_time,
    food_texture: (c.food_texture || '').trim() || null,   // b268
  }));

  // b268 — solid-food stage ("pureed / lumpy / whole"). Kept as its own list
  // rather than folded into `flagged`: a baby can need pureed food without a
  // single allergy, and serving them a whole piece is a choking risk regardless.
  // flagged_count still means "children with allergy/dietary needs", unchanged.
  const texture = signedIn
    .filter(c => c.food_texture && String(c.food_texture).trim())
    .map(c => ({ id: c.id, name: c.name, room: c.room, food_texture: String(c.food_texture).trim() }));

  // Today's menu allergens — b171 (2026-07-28): rotation-aware (active
  // menu_group_weeks week for `date`), via src/lib/menu-rotation.js.
  const dow = new Date(date + 'T00:00:00').getDay();
  const { items: weekItemsB } = await getMenuForDate(db, date, null);
  const menuRows = weekItemsB
    .filter(mi => mi.day_of_week === dow)
    .map(mi => ({ meal_type: mi.meal_type, description: mi.description, allergens: mi.allergens }));
  const menuAllergens = new Set();
  for (const m of menuRows) (m.allergens || []).forEach(a => menuAllergens.add(String(a).toUpperCase()));

  // Conflicts: a flagged child whose allergy text / allergen codes overlap today's menu.
  const conflicts = flagged.filter(c => {
    const txt = `${c.allergies} ${c.dietary_requirements} ${c.allergen_notes} ${(c.allergens || []).join(' ')}`.toUpperCase();
    return [...menuAllergens].some(code => code && txt.includes(code));
  }).map(c => ({ id: c.id, name: c.name, room: c.room, allergies: c.allergies, allergens: c.allergens }));

  return {
    date,
    signed_in_count: signedIn.length,
    flagged_count: flagged.length,
    texture_count: texture.length,                       // b268
    flagged, texture, menu_today: menuRows, menu_allergens: [...menuAllergens], conflicts,
  };
}

// GET /allergy-briefing?date=YYYY-MM-DD — briefing for children signed in today.
router.get('/allergy-briefing', async (req, res) => {
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : new Date().toISOString().slice(0, 10);
  try { res.json(await buildAllergyBriefing(getPool(), date)); }
  catch (e) { console.error('[kitchen/allergy-briefing]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /allergy-briefing/notify — push today's briefing to the kitchen Telegram.
router.post('/allergy-briefing/notify', express.json(), async (req, res) => {
  const date = (req.body && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '')) ? req.body.date : new Date().toISOString().slice(0, 10);
  try {
    const b = await buildAllergyBriefing(getPool(), date);
    const conflictIds = new Set(b.conflicts.map(x => x.id));
    const lines = b.flagged.map(c => {
      const bits = [c.allergies, c.dietary_requirements, c.allergen_notes].filter(x => x && x.trim()).join('; ');
      const clash = conflictIds.has(c.id) ? ' 🚨 CLASH with today\'s menu' : '';
      return `• *${c.name}* (${c.room || '—'}): ${bits || (c.allergens || []).join(', ') || 'see record'}${clash}`;
    });
    const header = `👨‍🍳 *Chef allergy briefing — ${date}*\n${b.signed_in_count} signed in, ${b.flagged_count} with allergy/dietary needs` +
                   (b.conflicts.length ? `, *${b.conflicts.length} menu clash(es)*` : '');
    const menu = b.menu_allergens.length ? `\n_Today's menu allergens: ${b.menu_allergens.join(', ')}_` : '';
    // b268 — solid-food stage. Its own block, because a pureed-only baby may not
    // appear anywhere in the allergy lines above and still must not be given
    // whole food.
    const textureBlock = (b.texture || []).length
      ? `\n\n🥄 *Food texture (choking risk)*\n` +
        b.texture.map(c => `• *${c.name}* (${c.room || '—'}): ${c.food_texture}`).join('\n')
      : '';
    const body = lines.length
      ? `${header}${menu}\n\n${lines.join('\n')}${textureBlock}`
      : `${header}\n\nNo allergy/dietary needs among children signed in today. ✅${textureBlock}`;
    await sendTelegram(body);
    res.json({ ok: true, sent: true, summary: { signed_in: b.signed_in_count, flagged: b.flagged_count, texture: (b.texture || []).length, conflicts: b.conflicts.length } });
  } catch (e) { console.error('[kitchen/allergy-briefing/notify]', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.buildAllergyBriefing = buildAllergyBriefing;

// GET /sensors/ha-status — live status directly from HA (battery, last_changed, online/offline)
// Inserted 2026-06-29 — temp log tab
router.get('/sensors/ha-status', async (req, res) => {
  const HA_URL = process.env.HA_LADN_URL;
  const HA_TOKEN = process.env.HA_LADN_TOKEN;
  if (!HA_URL || !HA_TOKEN) return res.status(503).json({ error: 'HA_LADN_URL/HA_LADN_TOKEN not configured' });
  const SENSORS = [
    { location: 'fridge',  temp: 'sensor.fridge_therm_temperature',  battery: 'sensor.fridge_therm_battery',  humidity: 'sensor.fridge_therm_humidity' },
    { location: 'freezer', temp: 'sensor.freezer_therm_temperature', battery: 'sensor.freezer_therm_battery', humidity: 'sensor.freezer_therm_humidity' }
  ];
  async function fetchEntity(id) {
    try {
      const r = await fetch(`${HA_URL}/api/states/${id}`, {
        headers: { Authorization: `Bearer ${HA_TOKEN}` },
        signal: AbortSignal.timeout(5000)
      });
      return r.ok ? r.json() : null;
    } catch { return null; }
  }
  try {
    const results = await Promise.all(SENSORS.map(async s => {
      const [temp, batt, hum] = await Promise.all([
        fetchEntity(s.temp), fetchEntity(s.battery), fetchEntity(s.humidity)
      ]);
      const lastChanged = temp?.last_changed || null;
      const staleMs = lastChanged ? Date.now() - new Date(lastChanged).getTime() : null;
      const staleHours = staleMs !== null ? Math.round(staleMs / 3600000) : null;
      const isOffline = !temp || temp.state === 'unavailable' || (staleMs !== null && staleMs > 3600000);
      return {
        location: s.location,
        state: temp?.state ?? null,
        last_changed: lastChanged,
        stale_hours: staleHours,
        is_offline: isOffline,
        battery_pct: batt?.state != null && batt.state !== 'unknown' ? Number(batt.state) : null,
        humidity_pct: hum?.state != null && hum.state !== 'unknown' ? Number(hum.state) : null
      };
    }));
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── b331 (2026-09-15) — hand-logged fridge/freezer reading (authenticated) ───
// /sensor-log now needs the Home Assistant token, so the EY kitchen "Temps" tab
// logs a hand reading here instead. Stored with source='manual', which the
// probe-plausibility check (src/lib/kitchen-simple.js#sensorStatus) ignores.
router.post('/manual-temp', express.json(), async (req, res) => {
  const { location, reading_c } = req.body || {};
  const r = Number(reading_c);
  if (!location || !/^[a-z0-9_-]{1,40}$/i.test(String(location)) || reading_c === '' || reading_c == null ||
      !Number.isFinite(r) || r < -60 || r > 100) {
    return res.status(400).json({ error: 'location and a sensible reading_c required' });
  }
  try {
    const db = getPool();
    const { rows: th } = await db.query('SELECT min_c, max_c FROM kitchen_temp_thresholds WHERE location=$1', [location]);
    const oor = th[0] ? (r < Number(th[0].min_c) || r > Number(th[0].max_c)) : false;
    const { rows } = await db.query(
      `INSERT INTO kitchen_sensor_readings (location, sensor_id, reading_c, out_of_range, source)
       VALUES ($1, $2, $3, $4, 'manual') RETURNING id, recorded_at`,
      [location, `staff:${(req.user && req.user.id) || '?'}`, r, oor]);
    res.status(201).json({ id: rows[0].id, location, reading_c: r, out_of_range: oor });
  } catch (e) { console.error('[kitchen/manual-temp]', e.message); res.status(500).json({ error: e.message }); }
});

// ── b331 (2026-09-15) — the kitchen, made simple for the chef ────────────────────
// Five big buttons on /ey/kitchen + the four-weekly SFBB review in Roost.
// Mounted here so every /api/kitchen/simple/* path sits behind this router's
// authenticate + kitchen-access gate (cook/chef role, or kitchen.access).
router.use('/simple', require('./kitchen-simple'));

// ── b540 (2026-11-02) — the chef's Sainsbury's list + kitchen training progress ──
// /api/kitchen/shop/*, behind the same authenticate + kitchen-access gate.
router.use('/shop', require('./kitchen-shop'));
