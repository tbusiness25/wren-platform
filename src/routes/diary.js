const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const { checkEnum } = require('../lib/enum-guard');
const authenticate = require('../middleware/auth');
const { operationalChildFilter, ensureEnrolmentMiddleware } = require('../utils/enrolment'); // b96
const { getMenuForDate } = require('../lib/menu-rotation'); // b171 (2026-07-28) — rotation-aware menu weeks
// b237 (2026-08-27) — daily-diary.* were in the matrix and read by nothing.
const { requireCapabilityLevel, capabilityLevel, CAPABILITY_LEVELS: LEVELS } = require('../lib/capabilities');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// edit-own vs edit-any, decided by who recorded the entry (diary_entries.staff_id).
// The 4-hour edit window in PATCH /entries/:id is a SEPARATE, unchanged rule.
async function _requireDiaryEditPermission(req, res, next) {
  const deny = cap => res.status(403).json({ error: 'capability_forbidden', capability: cap,
    required_level: 'edit' });
  try {
    const { rows } = await getPool().query(
      'SELECT staff_id FROM diary_entries WHERE id=$1', [req.params.id]);
    if (!rows.length) return next(); // let the route answer 404
    const isOwn = Number(rows[0].staff_id) === Number(req.user.id);
    const needed = isOwn ? 'daily-diary.edit-own' : 'daily-diary.edit-any';
    const level = await capabilityLevel(req.user, needed);
    if (LEVELS.indexOf(level) >= LEVELS.indexOf('edit')) return next();
    return deny(needed);
  } catch (e) { return deny('daily-diary.edit-own'); } // fail closed
}
router.use(ensureEnrolmentMiddleware(getPool));

router.use(authenticate);

const DIARY_MEAL_ORDER = { breakfast: 1, morning_snack: 2, lunch: 3, afternoon_snack: 4, snack: 2, tea: 5 };

// GET /menu/today — today's menu from the active menu_group's active rotation week.
// b171 (2026-07-28): rotation-aware via src/lib/menu-rotation.js — resolves
// menu_group_weeks Week N for today instead of returning every week's items.
router.get('/menu/today', async (req, res) => {
  try {
    const db = getPool();
    const date = new Date().toISOString().slice(0, 10);
    const dow = new Date().getDay(); // 0=Sun,1=Mon...
    const pgDow = dow === 0 ? 1 : dow === 6 ? 5 : dow; // clamp to 1-5
    const { group, items } = await getMenuForDate(db, date, null);
    const rows = items
      .filter(mi => mi.day_of_week === pgDow)
      .map(mi => ({ meal_type: mi.meal_type, description: mi.description, allergens: mi.allergens, menu_name: group ? group.name : null }))
      .sort((a, b) => (DIARY_MEAL_ORDER[a.meal_type] || 9) - (DIARY_MEAL_ORDER[b.meal_type] || 9));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /menu/week — full week from the active menu_group's active rotation week.
// b171 (2026-07-28): rotation-aware — see /menu/today above.
router.get('/menu/week', async (req, res) => {
  try {
    const db = getPool();
    const date = new Date().toISOString().slice(0, 10);
    const { group, items } = await getMenuForDate(db, date, null);
    const rows = items
      .map(mi => ({ day_of_week: mi.day_of_week, meal_type: mi.meal_type, description: mi.description, allergens: mi.allergens, menu_name: group ? group.name : null }))
      .sort((a, b) => a.day_of_week - b.day_of_week || (DIARY_MEAL_ORDER[a.meal_type] || 9) - (DIARY_MEAL_ORDER[b.meal_type] || 9));
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
router.post('/', requireCapabilityLevel('daily-diary.create', 'edit'), async (req, res) => {
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
router.put('/:id', requireCapabilityLevel('daily-diary.edit-own', 'edit'), async (req, res) => {
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
  const date     = req.query.date     || require('../lib/employment-rules').londonParts(new Date()).ymd;
  const room     = req.query.room     || null;
  const childId  = req.query.child_id ? parseInt(req.query.child_id, 10) : null;
  const type     = req.query.type     || null;
  try {
    const db = getPool();
    const params = [date];
    let extra = '';
    // 2026-09-29 — was lower(c.room_name): children has no such column, so any room filter 500'd.
    if (room)    { params.push(`%${room.toLowerCase()}%`); extra += ` AND lower(c.room) LIKE $${params.length}`; }
    if (childId) { params.push(childId);                   extra += ` AND de.child_id = $${params.length}`; }
    if (type)    { params.push(type);                      extra += ` AND de.entry_type = $${params.length}`; }
    const { rows } = await db.query(`
      SELECT de.*, c.first_name, c.last_name, c.room as room_name,
             s.first_name || ' ' || s.last_name AS staff_name
      FROM diary_entries de
      JOIN children c ON c.id = de.child_id
      LEFT JOIN staff s ON s.id = de.staff_id
      WHERE (de.occurred_at AT TIME ZONE 'Europe/London')::date = $1::date
        AND de.deleted_at IS NULL
        ${extra}
      ORDER BY de.occurred_at DESC
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /entries — add one or more entries (fan-out across child_ids)
// b160: entries logged through the EY flow default to status='draft' (staff-only)
// and are made visible to parents by the end-of-day "Publish today's diary" action.
// Any other caller that doesn't pass status keeps the pre-b160 behaviour (published).
router.post('/entries', requireCapabilityLevel('daily-diary.create', 'edit'), async (req, res) => {
  const { child_ids, entry_type, occurred_at, duration_minutes, food_amount: rawAmount, food_meal: rawMeal,
    nappy_state, drink_ml, drink_type, sleep_quality, notes, share_with_parents,
    cream_applied } = req.body; // item 3: nappy barrier-cream tickbox
  // b330: 'none' is not a food_amount the column takes (ate nothing = refused), and
  // the Snack chip sends 'snack'. Both used to 400 and then sit in the tablet's queue.
  const food_amount = rawAmount === 'none' ? 'refused' : rawAmount;
  const food_meal   = normMeal(rawMeal, occurred_at);
  if (!child_ids || !child_ids.length || !entry_type) {
    return res.status(400).json({ error: 'child_ids and entry_type required' });
  }
  const status = req.body.status === 'draft' ? 'draft' : 'published';
  const ts = occurred_at || new Date().toISOString();
  const cream = (cream_applied === true || cream_applied === 'true') || null;
  try {
    const db = getPool();
    // b280 (2026-09-08): every one of these went to Postgres unvalidated, so a bad
    // value returned a 500 carrying the raw CHECK text. Checked BEFORE the loop as
    // well as for the message: this writes one row per child, and failing on child
    // three of five used to leave the first two written and report only the error.
    for (const [col, val] of [
      ['entry_type',    entry_type],
      ['nappy_state',   nappy_state],
      ['drink_type',    drink_type],
      ['food_amount',   food_amount],
      ['food_meal',     food_meal],
      ['sleep_quality', sleep_quality],
    ]) {
      const bad = await checkEnum(db, 'diary_entries', col, val);
      if (bad) return res.status(400).json(bad);
    }
    const ids = [];
    for (const child_id of child_ids) {
      const { rows } = await db.query(`
        INSERT INTO diary_entries
          (child_id, entry_type, occurred_at, duration_minutes, food_amount, food_meal,
           nappy_state, drink_ml, drink_type, sleep_quality, notes, share_with_parents, staff_id, status, cream_applied)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING id
      `, [child_id, entry_type, ts, duration_minutes||null, food_amount||null, food_meal||null,
          nappy_state||null, drink_ml||null, drink_type||null, sleep_quality||null,
          notes||null, share_with_parents !== false, req.user.id, status, cream]);
      if (rows[0]) ids.push(rows[0].id);
    }
    res.status(201).json({ ids });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /entries/:id — edit within 4 hours
router.patch('/entries/:id', _requireDiaryEditPermission, async (req, res) => {
  const db = getPool();
  try {
    const existing = await db.query(
      'SELECT * FROM diary_entries WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
    const entry = existing.rows[0];
    const ageHours = (Date.now() - new Date(entry.created_at).getTime()) / 3600000;
    if (ageHours > 4 && !hasRole(req.user, ['manager', 'admin', 'deputy_manager'])) {
      return res.status(403).json({ error: 'Can only edit entries within 4 hours' });
    }
    // 2026-09-23 — staff: "the daily diary changes what has been filled in".
    // Every field here used to be written as COALESCE($n, column), which cannot tell
    // "the caller did not mention this field" from "the caller cleared it". So a
    // practitioner who removed a note, or unset an amount, saved it, and watched the old
    // value come straight back. The entry appeared to edit itself.
    //
    // A key that is ABSENT from the body is left alone; a key that is PRESENT is written,
    // including when its value is null. That is the whole difference.
    const B = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(B, k);
    // diaryfix2 (2026-10-13): POST /entries maps the tablet's 'snack' chip to
    // snack-am/snack-pm and 'none' to 'refused' (b330) — this PATCH did not. The
    // single-child diary's b404 autosave POSTs once and then PATCHes, so the moment
    // staff tapped Snack or None every later autosave 500'd on the CHECK constraint
    // ("Not saved — will retry") and the draft never changed. Same mapping here, and
    // the same b280 enum guard, so a bad value is a 400 with the allowed list.
    if (has('food_meal') && B.food_meal) B.food_meal = normMeal(B.food_meal, B.occurred_at || entry.occurred_at);
    if (has('food_amount') && B.food_amount === 'none') B.food_amount = 'refused';
    for (const col of ['food_meal', 'food_amount', 'nappy_state', 'drink_type', 'sleep_quality']) {
      if (!has(col)) continue;
      const bad = await checkEnum(db, 'diary_entries', col, B[col]);
      if (bad) return res.status(400).json(bad);
    }
    const FIELDS = [
      ['food_amount'], ['food_meal'], ['nappy_state'], ['drink_ml'], ['drink_type'],
      ['sleep_quality'], ['duration_minutes'], ['notes'], ['share_with_parents'],
      ['occurred_at', '::timestamptz'],
      ['cream_applied', '', (v) => (v == null ? null : (v === true || v === 'true'))],
    ];
    const sets = [];
    const vals = [];
    for (const [col, cast, coerce] of FIELDS) {
      if (!has(col)) continue;
      let v = B[col];
      if (coerce) v = coerce(v);
      if (col === 'occurred_at' && !v) v = null;
      vals.push(v);
      sets.push(`${col}=$${vals.length}${cast || ''}`);
    }
    if (!sets.length) return res.json(entry);          // nothing asked for, nothing changed
    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE diary_entries SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /entries/:id — soft delete
router.delete('/entries/:id', _requireDiaryEditPermission, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE diary_entries SET deleted_at=now() WHERE id=$1
       RETURNING id, child_id, entry_type, food_meal,
                 to_char((occurred_at AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS day`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    // diaryfix2 (2026-10-13): a food entry is mirrored into food_intake_log by
    // POST /group (one row per child+day+meal). Removing the diary entry left that
    // row behind, so the kitchen/intake figures still counted a meal the diary no
    // longer had. Drop the mirror only when no other live entry still covers it.
    const d = rows[0];
    if (d.entry_type === 'food' && d.food_meal) {
      await db.query(`
        DELETE FROM food_intake_log f
         WHERE f.child_id = $1 AND f.date = $2::date AND f.meal_type = $3
           AND NOT EXISTS (SELECT 1 FROM diary_entries de
                            WHERE de.child_id = $1 AND de.entry_type = 'food' AND de.food_meal = $3
                              AND de.deleted_at IS NULL
                              AND (de.occurred_at AT TIME ZONE 'Europe/London')::date = $2::date)
      `, [d.child_id, d.day, d.food_meal]).catch(() => {});   // non-fatal: the diary row is what staff see
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Group daily-diary entry (EyLog parity build, 2026-06-10) ────────────────
// POST /group  — fan-out a meal across all children in a room, one submit.
// Body: { date, meal_type, recipe_id, dish_name, room_id, entries: [{ child_id, amount, refused, notes }] }
// amount: 'none'|'some'|'half'|'most'|'all'   refused: bool
// Upserts both diary_entries (entry_type=food) and food_intake_log.
// Idempotent per child+date+meal_type (safe to retry / resync offline queue).
// b330 (2026-09-15): food_intake_log.amount_eaten_pct only takes 0/25/50/75/100.
// 33 and 66 failed that CHECK, so a group meal with any child on Some or Most
// 500'd and the room's whole entry was lost. And 'none' was recorded as 'some'.
// Toby 2026-09-15: None 0 · Some 25 · Half 50 · Most 75 · All 100.
const AMOUNT_PCT = { none: 0, some: 25, half: 50, most: 75, all: 100 };
const AMOUNT_DIARY = { none: 'refused', some: 'some', half: 'half', most: 'most', all: 'all', refused: 'refused' };

// b330: the tablets' Snack chip sends 'snack'; food_meal only takes snack-am or
// snack-pm. Mapped here so entries already queued on a tablet save when they replay.
function normMeal(meal, when) {
  if (meal !== 'snack') return meal;
  let d = when ? new Date(when) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  const h = parseInt(new Intl.DateTimeFormat('en-GB',
    { hour: 'numeric', hour12: false, timeZone: 'Europe/London' }).format(d), 10);
  return h < 12 ? 'snack-am' : 'snack-pm';
}

router.post('/group', requireCapabilityLevel('daily-diary.create', 'edit'), async (req, res) => {
  const {
    date, meal_type: rawMeal, recipe_id, dish_name, entries,
    client_uuid,   // optional idempotency key from offline outbox
  } = req.body;
  const meal_type = normMeal(rawMeal);

  if (!entries || !entries.length || !meal_type) {
    return res.status(400).json({ error: 'entries and meal_type required' });
  }

  const db      = getPool();
  const day     = date || require('../lib/employment-rules').londonParts(new Date()).ymd;
  const recipeId = recipe_id ? parseInt(recipe_id, 10) : null;
  // b160: EY flow saves as draft; published to parents by the end-of-day action.
  const status  = req.body.status === 'draft' ? 'draft' : 'published';
  let created   = 0;
  const ids     = []; // b404: per-child diary_entries.id, same order as `entries`

  try {
    // b280: meal_type reached the food_meal CHECK unvalidated and a bad value
    // returned a 500 with the raw constraint text. One check before the loop —
    // the whole batch shares the meal.
    {
      const bad = await checkEnum(db, 'diary_entries', 'food_meal', meal_type);
      if (bad) return res.status(400).json(bad);
    }
    // b330: all or nothing — a failure on child five no longer leaves one to four
    // written and then written again by the retry.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const entry of entries) {
        const { child_id, amount, refused, notes } = entry;
        if (!child_id) continue;

        const isRefused    = !!refused;
        const amtKey       = isRefused ? 'refused' : String(amount || 'all').toLowerCase().replace('-', '_');
        // diaryfix2 (2026-10-13): 'not_offered' — the one-page meals diary's fifth
        // button (left before tea, no pudding today). Kept as a staff-only food row
        // (food_amount NULL, share_with_parents false) so the day's record says the
        // meal was not given rather than looking forgotten; never counted as intake.
        const notOffered   = amtKey === 'not_offered';
        const food_amount  = notOffered ? null : (AMOUNT_DIARY[amtKey] || 'some');
        const pct          = (isRefused || notOffered) ? null : (AMOUNT_PCT[amtKey] != null ? AMOUNT_PCT[amtKey] : 100);
        // 2026-09-29 — London wall-clock now on the chosen day (was the UTC clock read as UTC).
        const occurred_at  = (require('../lib/employment-rules').londonInstant(day, require('../lib/employment-rules').londonParts(new Date()).hm) || new Date()).toISOString();
        const entryNotes   = notOffered ? 'Not offered'
                           : ([isRefused ? 'refused' : null, dish_name, notes].filter(Boolean).join(' — ') || null);
        const share        = !notOffered;

        // b330: one food entry per child per meal per day. The old ON CONFLICT had no
        // unique index behind it, so every offline retry added another copy.
        // b404: this UPDATE-first/INSERT-else pattern is already autosave-safe (repeat
        // calls for the same child+meal+day land on the same row) — RETURNING id so a
        // debounced autosave on /ey/diary/entry can track which row it is editing.
        // diaryfix2: notes — a re-save with no dish and no note used to wipe whatever
        // note the entry already had; now it keeps it (except the two auto-notes
        // 'Not offered'/'refused', which describe the old amount, not the new one).
        const upd = await client.query(`
          UPDATE diary_entries SET food_amount = $2,
                 notes = CASE WHEN $3::text IS NOT NULL THEN $3::text
                              WHEN notes IN ('Not offered', 'refused') THEN NULL
                              ELSE notes END,
                 share_with_parents = $6
           WHERE child_id = $1 AND entry_type = 'food' AND food_meal = $4
             AND (occurred_at AT TIME ZONE 'Europe/London')::date = $5::date
             AND deleted_at IS NULL
          RETURNING id
        `, [child_id, food_amount, entryNotes, meal_type, day, share]);
        let entryId = upd.rows[0] && upd.rows[0].id;
        if (!upd.rowCount) {
          const ins = await client.query(`
            INSERT INTO diary_entries
              (child_id, entry_type, occurred_at, food_amount, food_meal, notes, share_with_parents, staff_id, status)
            VALUES ($1,'food',$2,$3,$4,$5,$8,$6,$7)
            RETURNING id
          `, [child_id, occurred_at, food_amount, meal_type, entryNotes, req.user.id, status, share]);
          entryId = ins.rows[0] && ins.rows[0].id;
        }
        ids.push(entryId);

        if (notOffered) {
          // Not given = no intake: drop any mirror an earlier amount left behind.
          await client.query(
            'DELETE FROM food_intake_log WHERE child_id=$1 AND date=$2::date AND meal_type=$3',
            [child_id, day, meal_type]);
          created++;
          continue;
        }

        // Upsert food_intake_log (idempotent on child+date+meal_type)
        await client.query(`
          INSERT INTO food_intake_log
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
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ created, ids, client_uuid: client_uuid || null });
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
      FROM children c
      -- diaryfix2 (2026-10-13): was a plain LEFT JOIN on child+date, so once a
      -- second meal was logged every child came back twice (three times after tea)
      -- and the group diary drew duplicate rows. One row per child: latest meal.
      LEFT JOIN LATERAL (
        SELECT f.meal_type, f.amount_eaten_pct FROM food_intake_log f
         WHERE f.child_id = c.id AND f.date = $2
         ORDER BY f.recorded_at DESC NULLS LAST, f.id DESC LIMIT 1
      ) fil ON true
      WHERE c.room_id = $1
        AND ${operationalChildFilter('c')}
      ORDER BY c.first_name, c.last_name
    `, [parseInt(room_id, 10), day]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── b160: end-of-day publish + draft counting ───────────────────────────────
// Resolve the set of child_ids a publish/count action applies to.
//   { child_ids:[...] }  → exactly those (home-grid selection)
//   { room_id }          → every operational child in that room
//   (neither)            → all operational children (all-my-children / whole day)
async function _resolveScope(db, body) {
  if (Array.isArray(body.child_ids) && body.child_ids.length) {
    return body.child_ids.map(n => parseInt(n, 10)).filter(Boolean);
  }
  if (body.room_id) {
    const { rows } = await db.query(
      `SELECT id FROM children WHERE room_id=$1 AND ${operationalChildFilter('children')}`,
      [parseInt(body.room_id, 10)]);
    return rows.map(r => r.id);
  }
  const { rows } = await db.query(
    `SELECT id FROM children WHERE ${operationalChildFilter('children')}`);
  return rows.map(r => r.id);
}

// GET /draft-count?date=&room_id=&child_ids=1,2 — how many draft entries would publish.
router.get('/draft-count', async (req, res) => {
  const day = req.query.date || require('../lib/employment-rules').londonParts(new Date()).ymd;
  const body = {
    room_id: req.query.room_id || null,
    child_ids: req.query.child_ids ? String(req.query.child_ids).split(',') : null,
  };
  try {
    const db = getPool();
    const ids = await _resolveScope(db, body);
    if (!ids.length) return res.json({ date: day, entries: 0, children: 0 });
    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS entries, COUNT(DISTINCT child_id)::int AS children
      FROM diary_entries
      WHERE child_id = ANY($1) AND deleted_at IS NULL
        AND (occurred_at AT TIME ZONE 'Europe/London')::date = $2::date AND status='draft'
    `, [ids, day]);
    res.json({ date: day, entries: rows[0].entries, children: rows[0].children });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /publish-today — flip today's DRAFT diary entries → published for the scope.
// Body: { date?, room_id?, child_ids? }. Publishes both diary_entries (timeline —
// what parents actually see) and daily_diary (legacy summary) so nothing is left behind.
router.post('/publish-today', requireCapabilityLevel('daily-diary.edit-any', 'edit'), async (req, res) => {
  const day = req.body.date || require('../lib/employment-rules').londonParts(new Date()).ymd;
  try {
    const db = getPool();
    const ids = await _resolveScope(db, req.body);
    if (!ids.length) return res.json({ date: day, published_entries: 0, published_diary: 0, children: 0 });

    const de = await db.query(`
      UPDATE diary_entries SET status='published'
      WHERE child_id = ANY($1) AND deleted_at IS NULL
        AND (occurred_at AT TIME ZONE 'Europe/London')::date = $2::date AND status='draft'
      RETURNING child_id
    `, [ids, day]);

    const dd = await db.query(`
      UPDATE daily_diary SET status='published'
      WHERE child_id = ANY($1) AND date = $2 AND status='draft'
      RETURNING child_id
    `, [ids, day]).catch(() => ({ rowCount: 0, rows: [] }));

    const kids = new Set(de.rows.map(r => r.child_id));
    res.json({
      date: day,
      published_entries: de.rowCount,
      published_diary: dd.rowCount,
      children: kids.size,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
