const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// diary_entries CHECK constraints:
//   entry_type:    sleep | nappy | food | drink | note
//   sleep_quality: sound | restless | woke
//   nappy_state:   clean | wet | soiled | toilet
//   food_amount:   all | most | some | refused
//   food_meal:     breakfast | snack-am | lunch | snack-pm | tea
//   drink_type:    formula | EBM | cow | water | other

const SLEEP_Q_MAP = { asleep:'sound', sound:'sound', drowsy:'restless', restless:'restless', unsettled:'restless', awake:'woke', woke:'woke' };
const NAPPY_MAP   = { clean:'clean', dry:'clean', wet:'wet', soiled:'soiled', dirty:'soiled', toilet:'toilet' };
const FOOD_AMT_MAP= { all:'all', most:'most', some:'some', half:'some', small:'some', none:'refused', refused:'refused' };
const FOOD_MEAL_MAP={ breakfast:'breakfast', 'snack-am':'snack-am', 'morning snack':'snack-am', snack:'snack-am', lunch:'lunch', 'snack-pm':'snack-pm', 'afternoon snack':'snack-pm', tea:'tea' };
const DRINK_MAP   = { formula:'formula', ebm:'EBM', 'breast milk':'EBM', expressed:'EBM', cow:'cow', 'cows milk':'cow', "cow's milk":'cow', water:'water', other:'other' };

function mapVal(map, v, fallback) {
  if (!v) return fallback || null;
  return map[v.toLowerCase()] || map[v] || fallback || null;
}

// Build UTC ISO timestamp from YYYY-MM-DD + HH:MM
function ts(date, time) {
  if (!date || !time) return new Date().toISOString();
  return new Date(`${date}T${time}:00`).toISOString();
}

// Minutes between two HH:MM strings
function diffMins(a, b) {
  if (!a || !b) return null;
  const toM = s => { const [h,m] = s.split(':').map(Number); return h*60+m; };
  let d = toM(b) - toM(a);
  if (d < 0) d += 1440;
  return d || null;
}

// POST /group — fan-out a group action across child_ids
// type:        sleep | nappy | food | bottle | toilet | observation
router.post('/group', async (req, res) => {
  const { child_ids, type, date, common = {}, per_child = {}, notes } = req.body;
  if (!child_ids || !child_ids.length || !type) {
    return res.status(400).json({ error: 'child_ids and type required' });
  }

  const db   = getPool();
  const day  = date || new Date().toISOString().slice(0, 10);
  let created = 0;

  // For food entries, resolve the day's dish from the menu recipe so the diary
  // timeline shows WHAT was eaten (EyLog model — food comes from the menu plan).
  let dishName = null;
  const recipeId = common.recipe_id ? parseInt(common.recipe_id, 10) : null;
  if (type === 'food' && recipeId) {
    try {
      const { rows } = await db.query(
        'SELECT name FROM ladn.menu_recipes WHERE id=$1', [recipeId]);
      dishName = rows[0] ? rows[0].name : null;
    } catch (e) { /* non-fatal: dish name is decorative */ }
  }

  const PCT = { all: 100, most: 75, some: 33, refused: 0 };

  try {
    if (type === 'observation') {
      const occurred_at = ts(day, common.time || new Date().toTimeString().slice(0,5));
      for (const child_id of child_ids) {
        await db.query(`
          INSERT INTO ladn.observations
            (child_id, staff_id, title, observation_text, eyfs_areas, next_steps,
             created_at, updated_at, shared_with_parents)
          VALUES ($1,$2,$3,$4,$5,$6,COALESCE($8::timestamptz, now()),now(),$7)
        `, [
          child_id, req.user.id,
          common.title || 'Group Observation',
          common.text  || '',
          common.eyfs_areas || [],
          notes || null,
          common.share !== false,
          occurred_at,   // bind the picked date/time (was dropped → stored now())
        ]);
        created++;
      }
    } else {
      for (const child_id of child_ids) {
        const pc = per_child[child_id] || per_child[String(child_id)] || {};
        let entry_type, occurred_at, duration_minutes, food_amount, food_meal,
            nappy_state, drink_ml, drink_type, sleep_quality;

        switch (type) {
          case 'sleep':
            entry_type       = 'sleep';
            occurred_at      = ts(day, common.start || '');
            duration_minutes = diffMins(common.start || '', pc.end || common.end || '');
            sleep_quality    = mapVal(SLEEP_Q_MAP, pc.status || common.status, 'sound');
            break;

          case 'nappy':
            entry_type  = 'nappy';
            occurred_at = ts(day, common.time || '');
            nappy_state = mapVal(NAPPY_MAP, pc.state || common.state, 'wet');
            break;

          case 'food':
            entry_type  = 'food';
            occurred_at = ts(day, common.time || '');
            food_meal   = mapVal(FOOD_MEAL_MAP, common.meal, 'lunch');
            // EyLog model: every child defaults to "ate all"; per-child overrides win.
            food_amount = mapVal(FOOD_AMT_MAP, pc.amount != null ? String(pc.amount) : (common.amount != null ? String(common.amount) : null), 'all');
            break;

          case 'bottle':
            entry_type  = 'drink';
            occurred_at = ts(day, common.time || '');
            drink_type  = mapVal(DRINK_MAP, common.drink_type, 'formula');
            drink_ml    = pc.amount_ml != null ? parseInt(pc.amount_ml)
                        : common.amount_ml  != null ? parseInt(common.amount_ml) : null;
            break;

          case 'toilet':
            entry_type  = 'nappy';
            occurred_at = ts(day, common.time || '');
            nappy_state = mapVal(NAPPY_MAP, pc.outcome || common.outcome, 'toilet');
            break;

          default:
            entry_type  = 'note';
            occurred_at = ts(day, common.time || common.start || '');
        }

        // For food, prefix the dish name (from the menu) onto the entry notes.
        let entryNotes = notes || null;
        if (type === 'food' && dishName) {
          entryNotes = notes ? `${dishName} — ${notes}` : dishName;
        }

        await db.query(`
          INSERT INTO ladn.diary_entries
            (child_id, entry_type, occurred_at, duration_minutes,
             food_amount, food_meal, nappy_state, drink_ml, drink_type,
             sleep_quality, notes, share_with_parents, staff_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [
          child_id, entry_type, occurred_at || new Date().toISOString(),
          duration_minutes || null, food_amount || null, food_meal || null,
          nappy_state || null, drink_ml || null, drink_type || null,
          sleep_quality || null, entryNotes,
          common.share !== false,
          req.user.id,
        ]);

        // Mirror food into food_intake_log (menu/allergen tracking) when we know the dish.
        if (type === 'food' && recipeId) {
          try {
            await db.query(`
              INSERT INTO ladn.food_intake_log
                (child_id, date, meal_type, recipe_id, amount_eaten_pct, notes, recorded_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7)
              ON CONFLICT DO NOTHING
            `, [child_id, day, food_meal || common.meal || 'lunch', recipeId,
                PCT[food_amount] != null ? PCT[food_amount] : 100,
                notes || null, req.user.name || String(req.user.id)]);
          } catch (e) { /* non-fatal */ }
        }

        created++;
      }
    }

    res.status(201).json({ created });
  } catch (e) {
    console.error('[daily-diary-group]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
