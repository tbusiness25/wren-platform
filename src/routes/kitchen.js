const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// ── Telegram helper (kitchen alerts) ─────────────────────────────────────────
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
  } catch (e) { console.error('[kitchen] telegram error:', e.message); }
}

// ── PUBLIC webhook (no auth — mounted before authenticate, like Dahua) ───────
// POST /api/kitchen/sensor-log  — Sonoff TH temperature/humidity ingest.
// Body: { location:'fridge'|'freezer', reading_c, sensor_id?, humidity_pct?, source? }
// Optional gate: if KITCHEN_SENSOR_TOKEN env is set, require matching x-kitchen-token header.
router.post('/sensor-log', express.json(), async (req, res) => {
  const gate = process.env.KITCHEN_SENSOR_TOKEN;
  if (gate && req.headers['x-kitchen-token'] !== gate) {
    return res.status(401).json({ error: 'bad token' });
  }
  const { location, reading_c, sensor_id, humidity_pct, source } = req.body || {};
  if (!location || reading_c === undefined || reading_c === null || isNaN(Number(reading_c))) {
    return res.status(400).json({ error: 'location and numeric reading_c required' });
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

// GET /current — get current or latest active menu group with items
router.get('/current', async (req, res) => {
  try {
    const db = getPool();
    const { rows: groups } = await db.query(
      `SELECT * FROM menu_groups WHERE is_active=true AND date_from <= CURRENT_DATE AND date_to >= CURRENT_DATE ORDER BY date_from DESC LIMIT 1`
    );
    let group = groups[0];
    if (!group) {
      // Get most recent group
      const { rows: latest } = await db.query('SELECT * FROM menu_groups ORDER BY date_to DESC LIMIT 1');
      group = latest[0];
    }
    if (!group) return res.json({ group: null, items: [] });
    const { rows: items } = await db.query('SELECT * FROM menu_items WHERE menu_group_id=$1 ORDER BY day_of_week, meal_type', [group.id]);
    res.json({ group, items });
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
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Manager only' });
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
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Manager only' });
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
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Manager only' });
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
router.get('/allergen-summary', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name||' '||c.last_name as name, c.room_id, r.name as room_name,
             c.allergies, c.dietary_requirements
      FROM children c
      LEFT JOIN rooms r ON r.id=c.room_id
      WHERE c.is_active=true
        AND (c.allergies IS NOT NULL AND c.allergies != '' AND c.allergies != '{}')
      ORDER BY c.last_name, c.first_name
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
    // Present children (attendance row not marked absent) with their allergy info
    const { rows: present } = await db.query(`
      SELECT c.id, c.first_name||' '||c.last_name AS name, c.room_id, r.name AS room,
             c.allergies, c.dietary_requirements
      FROM ladn.attendance a
      JOIN ladn.children c ON c.id = a.child_id
      LEFT JOIN ladn.rooms r ON r.id = c.room_id
      WHERE a.date = $1 AND COALESCE(a.absent,false) = false
      ORDER BY r.name, c.first_name
    `, [date]);

    const present_with_allergies = present.filter(c =>
      (c.allergies && c.allergies.trim() && c.allergies.trim() !== '{}') ||
      (c.dietary_requirements && c.dietary_requirements.trim() && c.dietary_requirements.trim() !== '{}'));

    // Absent-sick
    const { rows: absent_sick } = await db.query(`
      SELECT c.id, c.first_name||' '||c.last_name AS name, a.absence_reason
      FROM ladn.attendance a JOIN ladn.children c ON c.id = a.child_id
      WHERE a.date = $1 AND a.absent = true
        AND (a.absence_reason ILIKE '%sick%' OR a.absence_reason ILIKE '%ill%' OR a.absence_reason ILIKE '%unwell%')
      ORDER BY c.first_name
    `, [date]);

    // Today's menu allergens (active group + day_of_week 0=Sun..6=Sat → JS getDay)
    const dow = new Date(date + 'T00:00:00').getDay();
    const { rows: menuRows } = await db.query(`
      SELECT mi.meal_type, mi.description, mi.allergens
      FROM ladn.menu_items mi
      JOIN ladn.menu_groups mg ON mg.id = mi.menu_group_id
      WHERE mg.is_active = true AND mg.date_from <= $1::date AND mg.date_to >= $1::date
        AND mi.day_of_week = $2
    `, [date, dow]);
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
      absent_sick,
      menu_today: menuRows,
      menu_allergens: [...menuAllergens],
      conflicts
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
