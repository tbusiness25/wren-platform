'use strict';
/**
 * src/lib/kitchen-simple.js — b331 (2026-09-15)
 *
 * The kitchen, made simple for the chef. Shared logic behind:
 *   - src/routes/kitchen-simple.js        (the five big buttons on /ey/kitchen,
 *                                          and the four-weekly review in Roost)
 *   - src/services/attention/kitchen.js   (cards on Toby's "What needs me" board)
 *   - src/jobs/kitchen-watch.js           (every 5 minutes: refresh + alert Toby)
 *
 * ── TIME ─────────────────────────────────────────────────────────────────────
 * The container and the database both run on UTC. "Before noon", "by 10:00" and
 * "by 17:30" are nursery times, so every clock decision here goes through
 * londonNow(). A date is always passed to SQL explicitly; nothing relies on
 * CURRENT_DATE / CURRENT_TIME (which would be a UTC date and time).
 *
 * ── MENUS ────────────────────────────────────────────────────────────────────
 * Today's dishes come from src/lib/menu-rotation.js#getMenuForDate (which overlays
 * the dated plans and folds the pudding into the lunch line). This file only
 * splits that line back into lunch and pudding for display; it is not another
 * menu reader.
 *
 * ── CHILD DATA ───────────────────────────────────────────────────────────────
 * Portions are counts. Allergy clashes name the child, because the cook has to
 * know whose plate it is — the same information the kitchen screen already
 * showed her. Nothing child-shaped is ever put on the attention board, into a
 * notification or into a log line.
 */

const crypto = require('crypto');
const { getMenuForDate } = require('./menu-rotation');
const { operationalChildFilter } = require('../utils/enrolment');

const TZ = 'Europe/London';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_COL = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ── time helpers ────────────────────────────────────────────────────────────
function londonNow(d) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p = {};
  for (const x of f.formatToParts(d || new Date())) p[x.type] = x.value;
  const hour = parseInt(p.hour, 10) % 24;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hhmm: `${String(hour).padStart(2, '0')}:${p.minute}`,
    hhmmss: `${String(hour).padStart(2, '0')}:${p.minute}:00`,
    minutes: hour * 60 + parseInt(p.minute, 10),
    dow: DOW.indexOf(p.weekday),
  };
}
function londonHHMM(ts) {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}
function londonDayLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}
function shortDayLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}
// pg hands a DATE back as local midnight; the container is UTC so local getters are right.
function isoDate(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dowOf(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }
function mondayStr(dateStr) { return addDays(dateStr, -((dowOf(dateStr) + 6) % 7)); }
function firstOfMonth(dateStr) { return dateStr.slice(0, 8) + '01'; }
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00Z')); }
function isWeekday(dateStr) { const d = dowOf(dateStr); return d >= 1 && d <= 5; }

// Who did it. The JWT carries "First Last"; the screens say "by the chef".
function whoName(user) {
  if (!user) return 'Staff';
  return String(user.name || user.first_name || `Staff ${user.id || ''}`).trim().slice(0, 100) || 'Staff';
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }

// ── settings ────────────────────────────────────────────────────────────────
async function getSetting(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    const v = rows[0] && rows[0].value;
    return v == null || String(v).trim() === '' ? fallback : String(v).trim();
  } catch { return fallback; }
}

// Safer Food Better Business limits. Fridge and freezer are overridable from
// settings (kitchen_fridge_max_c / kitchen_freezer_max_c) because Toby set the
// freezer range to -22…-10 in July and the brief for this build says -15.
const DEFAULT_LIMITS = {
  fridge_max: 8,             // chilled food must be 8°C or colder (legal limit)
  freezer_max: -15,          // b331 brief: flag a freezer warmer than -15°C
  cook_min: 75,              // core temperature when cooked
  hot_hold_min: 63,          // hot food kept hot
  delivery_chilled_max: 8,   // chilled deliveries
  probe_ice_min: -1, probe_ice_max: 1,       // probe in iced water
  probe_boil_min: 99, probe_boil_max: 101,   // probe in boiling water
  sensor_warm_minutes: 60,   // sensor above the limit this long = flag
  sensor_stale_minutes: 120, // no sensor reading this long = flag
};
async function getLimits(db) {
  const out = Object.assign({}, DEFAULT_LIMITS);
  const f = parseFloat(await getSetting(db, 'kitchen_fridge_max_c', ''));
  const z = parseFloat(await getSetting(db, 'kitchen_freezer_max_c', ''));
  if (Number.isFinite(f)) out.fridge_max = f;
  if (Number.isFinite(z)) out.freezer_max = z;
  return out;
}
function limitFor(location, limits) {
  return location === 'freezer' ? limits.freezer_max : limits.fridge_max;
}

async function alertStaffId(db) {
  const v = parseInt(await getSetting(db, 'kitchen_alert_staff_id', '1'), 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

// ── schema (additive, idempotent — mirrors scripts/b331-kitchen-simple.sql) ─
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS kitchen_sfbb_log (
     id serial PRIMARY KEY, date date NOT NULL,
     kind varchar(30) NOT NULL CHECK (kind IN ('delivery','hot_holding','cooling','probe_calibration')),
     food text, supplier text, temp_c numeric(5,1), temp2_c numeric(5,1), ok boolean, notes text,
     recorded_by varchar(100), recorded_by_id integer, recorded_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_kitchen_sfbb_log_date ON kitchen_sfbb_log (date, kind)`,
  `CREATE TABLE IF NOT EXISTS kitchen_events (
     id serial PRIMARY KEY, date date NOT NULL, kind varchar(30) NOT NULL, ref text,
     detail jsonb NOT NULL DEFAULT '{}'::jsonb, recorded_by varchar(100), recorded_by_id integer,
     recorded_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_kitchen_events_date ON kitchen_events (date, kind)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kitchen_events_alert_uq ON kitchen_events (ref) WHERE kind = 'alert_sent'`,
  `CREATE TABLE IF NOT EXISTS kitchen_shopping_favourites (
     id serial PRIMARY KEY, name varchar(80) NOT NULL UNIQUE, unit varchar(30),
     sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS kitchen_sfbb_reviews (
     id serial PRIMARY KEY, period_start date NOT NULL, period_end date NOT NULL,
     problems_found text, actions_taken text, changes text,
     reviewed_by varchar(100), reviewed_by_id integer, reviewed_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (period_start, period_end))`,
  `ALTER TABLE shopping_lists ADD COLUMN IF NOT EXISTS source varchar(20)`,
  `ALTER TABLE shopping_lists ADD COLUMN IF NOT EXISTS sent_by_id integer`,
  `ALTER TABLE shopping_lists ADD COLUMN IF NOT EXISTS note text`,
];
const FAVOURITES = [
  ['Whole milk', '4-pint bottle'], ['Bread', 'loaf'], ['Butter', 'block'], ['Eggs', 'box of 12'],
  ['Cheddar cheese', 'block'], ['Natural yoghurt', 'big pot'], ['Bananas', 'bunch'], ['Apples', 'bag'],
  ['Pears', 'bag'], ['Carrots', 'bag'], ['Potatoes', 'bag'], ['Onions', 'bag'], ['Broccoli', 'head'],
  ['Cucumber', 'each'], ['Frozen peas', 'bag'], ['Tinned tomatoes', 'tin'], ['Pasta', 'bag'], ['Rice', 'bag'],
  ['Porridge oats', 'bag'], ['Chicken breast', 'pack'], ['Beef mince', 'pack'], ['Fish fillets (frozen)', 'bag'],
  ['Washing-up liquid', 'bottle'], ['Kitchen roll', 'pack'], ['Sanitiser spray', 'bottle'], ['Bin bags', 'roll'],
];
let _schemaReady = null;
function ensureSchema(db) {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      for (const sql of SCHEMA_SQL) await db.query(sql);
      const { rows } = await db.query('SELECT count(*)::int AS n FROM kitchen_shopping_favourites');
      if (!rows[0].n) {
        for (let i = 0; i < FAVOURITES.length; i++) {
          await db.query(
            'INSERT INTO kitchen_shopping_favourites (name, unit, sort_order) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING',
            [FAVOURITES[i][0], FAVOURITES[i][1], (i + 1) * 10]);
        }
      }
      await db.query(
        `INSERT INTO settings (key, value) VALUES ('kitchen_checks_alert_from', $1) ON CONFLICT (key) DO NOTHING`,
        [londonNow().date]);
    })().catch(e => { _schemaReady = null; throw e; });
  }
  return _schemaReady;
}

// ── the checks — one question per screen ────────────────────────────────────
// section/item are the exact strings the existing sfbb_records / Roost "SFBB
// Diary" tab already use, so Toby's grid shows the chef's answers. Every question
// is worded so that YES is the good answer.
const CHECKS = {
  opening: [
    { key: 'fridge', type: 'temp', location: 'fridge', section: 'Temperatures', item: 'Fridge temperature recorded (°C)',
      ask: 'What does the fridge thermometer say?', hint: 'It should be 8°C or colder.' },
    { key: 'freezer', type: 'temp', location: 'freezer', negative: true, section: 'Temperatures', item: 'Freezer temperature recorded (°C)',
      ask: 'What does the freezer thermometer say?', hint: 'It should be minus 15°C or colder. The minus sign is already there.' },
    { key: 'staff_well', type: 'yesno', section: 'Staff health', item: 'All kitchen staff fit to work (no sickness/diarrhoea in last 48h)',
      ask: 'Is everyone working in the kitchen well today?', hint: 'Nobody has been sick or had diarrhoea in the last 2 days.' },
    { key: 'surfaces', type: 'yesno', section: 'Cleanliness', item: 'Food prep surfaces clean & sanitised',
      ask: 'Are the worktops and chopping boards clean and sanitised?' },
    { key: 'handwash', type: 'yesno', section: 'Cleanliness', item: 'Hand-wash basin stocked (soap & towels)',
      ask: 'Does the hand-wash sink have soap and paper towels?' },
    { key: 'probe_ok', type: 'yesno', section: 'Cleanliness', item: 'Probe thermometer working & sanitised',
      ask: 'Is the probe thermometer working and clean?' },
    { key: 'in_date', type: 'yesno', section: 'Stock', item: 'All food within use-by / best-before dates',
      ask: 'Is all the food in date?', hint: 'Look at the use-by dates in the fridge.' },
    { key: 'pests', type: 'yesno', section: 'Pest check', item: 'No signs of pests',
      ask: 'Is the kitchen free of pests?', hint: 'No droppings, nibbled packets or insects.' },
  ],
  closing: [
    { key: 'fridge', type: 'temp', location: 'fridge', section: 'Temperatures', item: 'Fridge temperature recorded (°C)',
      ask: 'What does the fridge thermometer say?', hint: 'It should be 8°C or colder.' },
    { key: 'freezer', type: 'temp', location: 'freezer', negative: true, section: 'Temperatures', item: 'Freezer temperature recorded (°C)',
      ask: 'What does the freezer thermometer say?', hint: 'It should be minus 15°C or colder. The minus sign is already there.' },
    { key: 'covered', type: 'yesno', section: 'Food storage', item: 'Leftovers labelled & dated',
      ask: 'Is all the food covered, labelled and put away?', hint: 'Tap Yes if there is nothing left over.' },
    { key: 'out_of_date', type: 'yesno', section: 'Food storage', item: 'Out-of-date food thrown away',
      ask: 'Has any out-of-date food been thrown away?', hint: 'Tap Yes if there was none.' },
    { key: 'allergen_store', type: 'yesno', section: 'Food storage', item: 'Allergen ingredients stored separately',
      ask: 'Are the allergy foods stored separately?' },
    { key: 'cooled', type: 'yesno', section: 'Food storage', item: 'Hot food cooled within 90 min & refrigerated',
      ask: 'Was any food kept for later in the fridge within 90 minutes?', hint: 'Tap Yes if no cooked food was kept.' },
    { key: 'surfaces_clean', type: 'yesno', section: 'Cleaning down', item: 'Surfaces cleaned & sanitised',
      ask: 'Are the worktops cleaned and sanitised?', cleaning: /worktop|surface/i },
    { key: 'floors', type: 'yesno', section: 'Cleaning down', item: 'Floors swept & mopped',
      ask: 'Are the floors swept and mopped?', cleaning: /floor/i },
    { key: 'bins', type: 'yesno', section: 'Cleaning down', item: 'Bins emptied & sanitised',
      ask: 'Are the bins emptied?', cleaning: /\bbins?\b/i },
    { key: 'equipment', type: 'yesno', section: 'Cleaning down', item: 'Equipment cleaned & switched off',
      ask: 'Is the cooker and equipment clean and switched off?' },
    { key: 'probe_clean', type: 'yesno', section: 'Cleaning down', item: 'Probe thermometer cleaned',
      ask: 'Is the probe thermometer cleaned?' },
  ],
};
const SHIFT_LABEL = { opening: 'Morning checks', closing: 'End of day checks' };
const OPENING_DUE_MIN = 10 * 60;        // 10:00
const CLOSING_DUE_MIN = 17 * 60 + 30;   // 17:30

function publicChecks(shift) {
  return CHECKS[shift].map(d => ({ key: d.key, type: d.type, location: d.location || null, negative: !!d.negative, ask: d.ask, hint: d.hint || null }));
}

// The Roost SFBB Diary tab renders kitchen.js's own SFBB_CHECKLIST. Add any item
// the chef's questions use that it lacks (pest check, out-of-date food), so both
// screens show the same records. Additive — never removes or renames an item.
function extendLegacyChecklist(checklist) {
  for (const shift of ['opening', 'closing']) {
    if (!Array.isArray(checklist[shift])) continue;
    for (const d of CHECKS[shift]) {
      let sec = checklist[shift].find(s => s.section === d.section);
      if (!sec) { sec = { section: d.section, items: [] }; checklist[shift].push(sec); }
      if (!sec.items.includes(d.item)) sec.items.push(d.item);
    }
  }
  return checklist;
}

function parseTemp(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function readAnswer(def, row, limits) {
  if (!row) return { answered: false };
  const base = { at: row.recorded_at, at_hhmm: londonHHMM(row.recorded_at), by: row.recorded_by, notes: row.notes || null };
  if (def.type === 'temp') {
    const v = parseTemp(row.value_text);
    if (v == null) return { answered: false };
    const max = limitFor(def.location, limits);
    return Object.assign(base, { answered: true, value: v, problem: v > max, label: `${v}°C`, limit: max });
  }
  const vt = String(row.value_text || '').trim().toLowerCase();
  if (vt === 'no') return Object.assign(base, { answered: true, answer: 'no', problem: true, label: 'No' });
  if (vt === 'yes' || row.checked === true) return Object.assign(base, { answered: true, answer: 'yes', problem: false, label: 'Yes' });
  return { answered: false };
}

// rows: sfbb_records for ONE date.
function summariseChecks(rows, limits) {
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.shift}||${r.section}||${r.item}`, r);
  const out = {};
  for (const shift of ['opening', 'closing']) {
    const defs = CHECKS[shift];
    let answered = 0, lastAt = null, lastBy = null;
    const problems = [], answers = {};
    for (const d of defs) {
      const r = byKey.get(`${shift}||${d.section}||${d.item}`);
      const a = readAnswer(d, r, limits);
      answers[d.key] = a;
      if (a.answered) {
        answered++;
        const t = new Date(r.recorded_at);
        if (!lastAt || t > lastAt) { lastAt = t; lastBy = r.recorded_by; }
      }
      if (a.problem) {
        problems.push({
          key: d.key, shift, ask: d.ask, answer: a.label, notes: a.notes || null,
          what: d.type === 'temp'
            ? `${d.location === 'freezer' ? 'Freezer' : 'Fridge'} ${a.label} (should be ${a.limit}°C or colder)`
            : `"${d.ask}" — No`,
        });
      }
    }
    const done = answered === defs.length;
    out[shift] = {
      label: SHIFT_LABEL[shift], total: defs.length, answered, done,
      completed_at: done ? lastAt : null, completed_hhmm: done ? londonHHMM(lastAt) : null,
      completed_by: done ? lastBy : null, problems, answers,
    };
  }
  return out;
}

async function checksStatus(db, date, limits) {
  const { rows } = await db.query(
    `SELECT shift, section, item, checked, value_text, notes, recorded_by, recorded_at
       FROM sfbb_records WHERE date = $1::date`, [date]);
  return summariseChecks(rows, limits || await getLimits(db));
}

async function saveCheckAnswer(db, { date, shift, key, answer, note, user }) {
  if (!CHECKS[shift]) throw httpError(400, 'shift must be opening or closing');
  const def = CHECKS[shift].find(d => d.key === key);
  if (!def) throw httpError(400, 'unknown question');
  const limits = await getLimits(db);
  const cleanNote = note ? String(note).trim().slice(0, 500) : '';
  let checked, valueText, notes = cleanNote || null, problem = false, message = null;
  if (def.type === 'temp') {
    const v = parseTemp(answer);
    if (v == null) throw httpError(400, 'a temperature is needed');
    if (v < -40 || v > 60) throw httpError(400, 'that temperature does not look right — please check the number');
    const max = limitFor(def.location, limits);
    checked = true;
    valueText = String(v);
    if (v > max) {
      problem = true;
      message = `That is too warm. It should be ${max}°C or colder. Please tell Toby now.`;
      notes = `Too warm — should be ${max}°C or colder.${cleanNote ? ' ' + cleanNote : ''}`;
    }
  } else {
    const a = String(answer || '').toLowerCase();
    if (a !== 'yes' && a !== 'no') throw httpError(400, 'answer must be yes or no');
    checked = a === 'yes';
    valueText = a === 'yes' ? 'Yes' : 'No';
    if (a === 'no') { problem = true; message = 'Please tell Toby about this.'; }
  }
  await db.query(`
    INSERT INTO sfbb_records (date, shift, section, item, checked, value_text, notes, recorded_by, recorded_at)
    VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (date, shift, section, item) DO UPDATE SET
      checked = EXCLUDED.checked, value_text = EXCLUDED.value_text, notes = EXCLUDED.notes,
      recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
    [date, shift, def.section, def.item, checked, valueText, notes, whoName(user)]);
  return { saved: true, key, problem, message };
}

// Add a note to an answer already given (after a "No" or a too-warm reading).
async function noteCheckAnswer(db, { date, shift, key, note, user }) {
  const def = (CHECKS[shift] || []).find(d => d.key === key);
  if (!def) throw httpError(400, 'unknown question');
  const n = String(note || '').trim().slice(0, 500);
  if (!n) throw httpError(400, 'note is empty');
  const { rowCount } = await db.query(`
    UPDATE sfbb_records SET notes = CONCAT_WS(' ', NULLIF(notes, ''), $5::text), recorded_by = $6
     WHERE date = $1::date AND shift = $2 AND section = $3 AND item = $4`,
    [date, shift, def.section, def.item, n, whoName(user)]);
  if (!rowCount) throw httpError(404, 'answer the question first');
  return { saved: true };
}

// ── other SFBB records (deliveries, hot-holding, cooling, probe calibration) ─
async function saveLog(db, { date, kind, body, user }) {
  const limits = await getLimits(db);
  const food = body.food ? String(body.food).trim().slice(0, 200) : null;
  const supplier = body.supplier ? String(body.supplier).trim().slice(0, 120) : null;
  const notes = body.notes ? String(body.notes).trim().slice(0, 500) : null;
  const t1 = body.temp_c === '' || body.temp_c == null ? null : parseTemp(body.temp_c);
  const t2 = body.temp2_c === '' || body.temp2_c == null ? null : parseTemp(body.temp2_c);
  for (const t of [t1, t2]) if (t != null && (t < -40 || t > 120)) throw httpError(400, 'that temperature does not look right — please check the number');
  let ok, message;
  if (kind === 'delivery') {
    if (!supplier) throw httpError(400, 'who is the delivery from?');
    if (body.accepted !== true && body.accepted !== false) throw httpError(400, 'accepted yes or no is needed');
    const coldOk = t1 == null || t1 <= limits.delivery_chilled_max;
    ok = body.accepted === true && coldOk;
    message = !coldOk ? `The chilled food was too warm (should be ${limits.delivery_chilled_max}°C or colder). Tell Toby.`
      : (body.accepted ? 'Delivery saved.' : 'Delivery refused — saved. Tell Toby.');
  } else if (kind === 'hot_holding') {
    if (!food) throw httpError(400, 'which food?');
    if (t1 == null) throw httpError(400, 'a temperature is needed');
    ok = t1 >= limits.hot_hold_min;
    message = ok ? 'Hot enough. Saved.' : `Not hot enough — it should be ${limits.hot_hold_min}°C or hotter. Heat it up again or throw it away, and tell Toby.`;
  } else if (kind === 'cooling') {
    if (!food) throw httpError(400, 'which food?');
    if (body.in_time !== true && body.in_time !== false) throw httpError(400, 'yes or no is needed');
    ok = body.in_time === true;
    message = ok ? 'Saved.' : 'It took too long to cool. Throw it away, and tell Toby.';
  } else if (kind === 'probe_calibration') {
    if (t1 == null || t2 == null) throw httpError(400, 'both readings are needed');
    ok = t1 >= limits.probe_ice_min && t1 <= limits.probe_ice_max && t2 >= limits.probe_boil_min && t2 <= limits.probe_boil_max;
    message = ok ? 'The probe is working properly. Saved.' : 'The probe may be wrong. Do not use it — tell Toby.';
  } else {
    throw httpError(400, 'unknown record');
  }
  const { rows } = await db.query(`
    INSERT INTO kitchen_sfbb_log (date, kind, food, supplier, temp_c, temp2_c, ok, notes, recorded_by, recorded_by_id)
    VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, recorded_at`,
    [date, kind, food, supplier, t1, t2, ok, notes, whoName(user), user && user.id || null]);
  return { id: rows[0].id, ok, message };
}

async function logsForDate(db, date) {
  const { rows } = await db.query(
    `SELECT id, kind, food, supplier, temp_c, temp2_c, ok, notes, recorded_by, recorded_at
       FROM kitchen_sfbb_log WHERE date = $1::date ORDER BY recorded_at`, [date]);
  return rows.map(r => Object.assign(r, { at_hhmm: londonHHMM(r.recorded_at) }));
}

async function probeThisWeek(db, date) {
  const { rows } = await db.query(
    `SELECT date, ok, temp_c, temp2_c, recorded_by, recorded_at FROM kitchen_sfbb_log
      WHERE kind = 'probe_calibration' AND date BETWEEN $1::date AND $2::date
      ORDER BY recorded_at DESC LIMIT 1`, [mondayStr(date), date]);
  const r = rows[0];
  if (!r) return { done: false, label: 'Due this week' };
  return { done: true, ok: r.ok, date: isoDate(r.date), label: `Done ${DOW[dowOf(isoDate(r.date))]}${r.ok ? '' : ' — probe may be wrong'}` };
}

// ── cooking temperature for the main dish ───────────────────────────────────
async function saveCookingTemp(db, { date, food, temp, user }) {
  const limits = await getLimits(db);
  const t = parseTemp(temp);
  if (t == null) throw httpError(400, 'a temperature is needed');
  if (t < 0 || t > 120) throw httpError(400, 'that temperature does not look right — please check the number');
  const name = String(food || '').trim().slice(0, 200) || 'Lunch';
  const ok = t >= limits.cook_min;
  const { rows } = await db.query(
    `INSERT INTO kitchen_cooking_temps (date, food_name, temp_c, logged_at, logged_by_id, notes)
     VALUES ($1::date, $2, $3, $4::time, $5, $6) RETURNING id, created_at`,
    [date, name, t, londonNow().hhmmss, user && user.id || null, ok ? null : `Below ${limits.cook_min}°C`]);
  return {
    id: rows[0].id, ok, temp: t,
    message: ok ? `${t}°C — hot enough.` : `${t}°C — not hot enough yet. It must reach ${limits.cook_min}°C. Cook it for longer and check again.`,
  };
}
async function cookingTempToday(db, date) {
  const { rows } = await db.query(
    `SELECT food_name, temp_c, created_at FROM kitchen_cooking_temps
      WHERE date = $1::date ORDER BY created_at DESC LIMIT 1`, [date]);
  if (!rows[0]) return { done: false, label: 'Not taken yet' };
  const limits = await getLimits(db);
  const t = Number(rows[0].temp_c);
  return { done: t >= limits.cook_min, temp: t, food: rows[0].food_name, at_hhmm: londonHHMM(rows[0].created_at),
           label: `${t}°C at ${londonHHMM(rows[0].created_at)}${t >= limits.cook_min ? '' : ' — not hot enough'}` };
}

// ── today's menu (via getMenuForDate) ───────────────────────────────────────
function splitLunchLine(desc) {
  const s = String(desc || '');
  const m = s.split(/\s*·\s*Pudding:\s*/i);
  return { lunch: (m[0] || '').trim() || null, pudding: (m[1] || '').trim() || null };
}
async function menuForRoom(db, date, room) {
  const dow = dowOf(date);
  const res = await getMenuForDate(db, date, room);
  const day = (res.items || []).filter(i => i.day_of_week === dow);
  const lunchRow = day.find(i => i.meal_type === 'lunch');
  const pudRow = day.find(i => /pudding|dessert/i.test(String(i.meal_type || '')));
  const out = { lunch: null, pudding: null, allergens: [], source: lunchRow ? (lunchRow.source || 'rotation') : null };
  if (lunchRow) {
    const sp = splitLunchLine(lunchRow.description);
    out.lunch = sp.lunch; out.pudding = sp.pudding;
    (lunchRow.allergens || []).forEach(a => a && out.allergens.push(String(a).toLowerCase().trim()));
  }
  if (pudRow && !out.pudding) {
    out.pudding = String(pudRow.description || '').trim() || null;
    (pudRow.allergens || []).forEach(a => a && out.allergens.push(String(a).toLowerCase().trim()));
  }
  out.allergens = [...new Set(out.allergens.filter(Boolean))].sort();
  return out;
}
async function todaysMenu(db, date) {
  if (!isWeekday(date)) return { weekend: true, lunch: null, pudding: null, allergens: [], baby: null, dish_text: '' };
  const pre = await menuForRoom(db, date, 'preschool');
  const baby = await menuForRoom(db, date, 'baby');
  const differs = baby.lunch && (baby.lunch !== pre.lunch || baby.pudding !== pre.pudding);
  const lunch = pre.lunch || baby.lunch;
  const pudding = pre.pudding || baby.pudding;
  const allergens = [...new Set([...pre.allergens, ...baby.allergens])].sort();
  return {
    weekend: false, lunch, pudding, allergens, source: pre.source || baby.source,
    baby: differs ? { lunch: baby.lunch, pudding: baby.pudding } : null,
    dish_text: [lunch, pudding, differs ? baby.lunch : '', differs ? baby.pudding : ''].filter(Boolean).join(' '),
  };
}
async function weekMenu(db, date) {
  const mon = mondayStr(date);
  const res = await getMenuForDate(db, mon, 'preschool');
  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = addDays(mon, i);
    const row = (res.items || []).find(x => x.day_of_week === i + 1 && x.meal_type === 'lunch');
    const sp = row ? splitLunchLine(row.description) : { lunch: null, pudding: null };
    days.push({ date: d, day: londonDayLabel(d), lunch: sp.lunch, pudding: sp.pudding });
  }
  return days;
}

// ── children in today (the register; bookings if the register has not started) ─
async function childrenToday(db, date) {
  const { rows } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.room_id, r.name AS room,
           c.allergies, c.dietary_requirements, c.allergens, c.allergen_notes,
           NULLIF(TRIM(cam.food_allergies), '') AS food_allergies_about_me,
           NULLIF(TRIM(cam.food_texture), '')   AS food_texture,
           bool_or(NOT COALESCE(a.absent, false)) AS expected,
           bool_or(a.sign_in_time IS NOT NULL AND NOT COALESCE(a.absent, false)) AS signed_in,
           bool_or(a.sign_in_time IS NOT NULL AND a.sign_out_time IS NULL AND NOT COALESCE(a.absent, false)) AS here_now
      FROM attendance a
      JOIN children c ON c.id = a.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN child_about_me cam ON cam.child_id = c.id
     WHERE a.date = $1::date
     GROUP BY c.id, r.name, cam.food_allergies, cam.food_texture`, [date]);
  if (rows.length) {
    return { source: 'register', children: rows.filter(r => r.expected), absent: rows.filter(r => !r.expected).length };
  }
  const col = DOW_COL[dowOf(date)];
  if (!['mon', 'tue', 'wed', 'thu', 'fri'].includes(col)) return { source: 'none', children: [], absent: 0 };
  const { rows: booked } = await db.query(`
    SELECT DISTINCT ON (c.id) c.id, c.first_name, c.last_name, c.preferred_name,
           COALESCE(b.room_id, c.room_id) AS room_id, r.name AS room,
           c.allergies, c.dietary_requirements, c.allergens, c.allergen_notes,
           NULLIF(TRIM(cam.food_allergies), '') AS food_allergies_about_me,
           NULLIF(TRIM(cam.food_texture), '')   AS food_texture,
           true AS expected, false AS signed_in, false AS here_now
      FROM child_bookings b
      JOIN children c ON c.id = b.child_id
      LEFT JOIN rooms r ON r.id = COALESCE(b.room_id, c.room_id)
      LEFT JOIN child_about_me cam ON cam.child_id = c.id
     WHERE COALESCE(b.is_active, true) AND b.${col} = true
       AND (b.start_date IS NULL OR b.start_date <= $1::date)
       AND (b.end_date IS NULL OR b.end_date >= $1::date)
       AND ${operationalChildFilter('c')}
     ORDER BY c.id`, [date]);
  return { source: 'bookings', children: booked, absent: 0 };
}

// Counts only.
async function portionsToday(db, date) {
  const t = await childrenToday(db, date);
  const rooms = new Map();
  for (const c of t.children) {
    const k = c.room_id == null ? 'none' : String(c.room_id);
    if (!rooms.has(k)) rooms.set(k, { room_id: c.room_id, room: c.room || 'No room set', expected: 0, here_now: 0, baby: /bab/i.test(c.room || '') });
    const r = rooms.get(k);
    r.expected++;
    if (c.here_now) r.here_now++;
  }
  const list = [...rooms.values()].sort((a, b) => (a.room_id || 999) - (b.room_id || 999));
  return {
    source: t.source, rooms: list,
    total: list.reduce((s, r) => s + r.expected, 0),
    here_now: list.reduce((s, r) => s + r.here_now, 0),
    absent: t.absent,
  };
}

// ── allergen clashes ────────────────────────────────────────────────────────
// Menu allergen codes on production (2026-09-15): celery, coconut, eggs, fish,
// gluten, milk, oats, sesame, soya. The old matcher compared the upper-cased code
// with the child's text by substring, so "Egg allergy" never matched "EGGS" and
// "dairy free" never matched "MILK". This one knows the everyday words.
const ALLERGEN_WORDS = {
  milk: ['milk', 'dairy', 'lactose', 'cmpa', 'cmpi', "cow's", 'cows', 'cheese', 'yoghurt', 'yogurt', 'casein', 'whey', '=butter', '=cream', 'custard'],
  eggs: ['egg'],
  gluten: ['gluten', 'wheat', 'coeliac', 'celiac', 'barley', '=rye', 'spelt'],
  oats: ['oat'],
  fish: ['fish', 'salmon', 'tuna', '=cod', 'haddock', 'pollock'],
  sesame: ['sesame'],
  soya: ['soy'],
  celery: ['celery', 'celeriac'],
  coconut: ['coconut'],
  peanuts: ['peanut', 'groundnut'],
  nuts: ['=nut', 'tree nut', 'almond', 'hazelnut', 'cashew', 'walnut', 'pecan', 'pistachio', 'macadamia', 'brazil nut'],
  crustaceans: ['crustacean', 'prawn', 'shrimp', '=crab', 'lobster', 'shellfish'],
  molluscs: ['mollusc', 'mussel', 'oyster', 'squid', '=clam', 'scallop'],
  mustard: ['mustard'],
  lupin: ['lupin'],
  sulphites: ['sulphite', 'sulfite', 'sulphur dioxide'],
};
const MEAT = ['chicken', 'beef', 'pork', 'lamb', '=ham', 'bacon', 'sausage', 'mince', 'meatball', 'turkey', 'gammon',
  'chorizo', 'pepperoni', 'salami', 'burger', 'bolognese', 'cottage pie', 'shepherd', 'con carne', 'kebab', 'nugget', '=meat'];
const FISHY = ['fish', 'salmon', 'tuna', '=cod', 'haddock', 'pollock', 'prawn', 'kedgeree'];
const PORK = ['pork', '=ham', 'bacon', 'gammon', 'sausage', 'chorizo', 'pepperoni', 'salami', 'gelatine', 'gelatin'];
const BEEF = ['beef', 'bolognese', 'cottage pie', 'burger', 'mince', 'con carne', 'meatball'];
const DIETS = [
  { re: /\bvegan\b/i, label: 'vegan', dish: [...MEAT, ...FISHY, 'cheese', 'egg', 'milk', 'yoghurt', 'yogurt', 'custard', '=cream', '=butter', 'honey'], codes: ['milk', 'eggs', 'fish'] },
  { re: /\bvegetarian\b|\bveggie\b|\bno meat\b/i, label: 'vegetarian', dish: [...MEAT, ...FISHY], codes: ['fish'] },
  { re: /\bpesc[ae]tarian\b/i, label: 'no meat (eats fish)', dish: MEAT, codes: [] },
  { re: /\bhalal\b|\bno pork\b|\bkosher\b/i, label: 'no pork', dish: PORK, codes: [] },
  { re: /\bno beef\b/i, label: 'no beef', dish: BEEF, codes: [] },
];
const _reCache = new Map();
function wordRe(w) {
  if (_reCache.has(w)) return _reCache.get(w);
  const exact = w.startsWith('=');
  const body = (exact ? w.slice(1) : w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]?");
  const re = new RegExp(`\\b${body}${exact ? '(s|es)?\\b' : ''}`, 'i');
  _reCache.set(w, re);
  return re;
}
function hit(text, w) { return wordRe(w).test(text); }
function plain(w) { return w.replace(/^=/, ''); }
function wordsForCode(code) {
  const c = String(code || '').toLowerCase().trim();
  if (ALLERGEN_WORDS[c]) return { key: c, words: ALLERGEN_WORDS[c] };
  const k = Object.keys(ALLERGEN_WORDS).find(x => x === c + 's' || x.replace(/s$/, '') === c);
  if (k) return { key: k, words: ALLERGEN_WORDS[k] };
  return { key: c, words: [c] };
}
function childText(c) {
  return [c.allergies, c.dietary_requirements, c.allergen_notes, c.food_allergies_about_me,
    Array.isArray(c.allergens) ? c.allergens.join(' ') : '']
    .map(x => String(x || '').replace(/^\{\}$/, '').trim()).filter(Boolean).join(' · ');
}
function childClashes(c, menu) {
  const text = childText(c);
  if (!text) return [];
  const dish = String(menu.dish_text || '');
  const reasons = [];
  const seen = new Set();
  // 1. Allergens the recipes are tagged with, against the child's record.
  for (const code of menu.allergens || []) {
    const { key, words } = wordsForCode(code);
    if (seen.has(key)) continue;
    const w = words.find(x => hit(text, x));
    if (w) { seen.add(key); reasons.push({ kind: 'allergen', code: key, text: `Allergy: ${key}. Today's food contains ${key}.` }); }
  }
  // 2. A safety net for recipes that are not tagged: an allergy on the child's
  //    record whose everyday word also appears in the dish name.
  for (const [key, words] of Object.entries(ALLERGEN_WORDS)) {
    if (seen.has(key)) continue;
    if (!words.some(x => hit(text, x))) continue;
    const dw = words.find(x => hit(dish, x));
    if (dw) { seen.add(key); reasons.push({ kind: 'dish', code: key, text: `Allergy: ${key}. The menu says "${plain(dw)}" — check the ingredients.` }); }
  }
  // 3. Diets.
  for (const d of DIETS) {
    if (!d.re.test(text)) continue;
    const dw = d.dish.find(x => hit(dish, x));
    const code = d.codes.find(x => (menu.allergens || []).includes(x));
    if (dw || code) reasons.push({ kind: 'diet', code: d.label, text: `Diet: ${d.label}. Today's food has ${dw ? plain(dw) : code}. Check they get the right meal.` });
  }
  return reasons;
}
function displayName(c) {
  return `${(c.preferred_name && String(c.preferred_name).trim()) || c.first_name || ''} ${c.last_name || ''}`.trim();
}

async function allergenBoard(db, date) {
  const menu = await todaysMenu(db, date);
  const t = await childrenToday(db, date);
  const clashes = [], others = [], texture = [];
  for (const c of t.children) {
    const txt = childText(c);
    if (c.food_texture) texture.push({ id: c.id, name: displayName(c), room: c.room || null, food_texture: c.food_texture });
    if (!txt) continue;
    const reasons = menu.lunch || menu.pudding ? childClashes(c, menu) : [];
    if (reasons.length) clashes.push({ id: c.id, name: displayName(c), room: c.room || null, here_now: !!c.here_now, record: txt, reasons });
    else others.push({ id: c.id, name: displayName(c), room: c.room || null, record: txt });
  }
  clashes.sort((a, b) => String(a.room || '').localeCompare(String(b.room || '')) || a.name.localeCompare(b.name));
  // What exactly was on screen. If a child signs in late with a clash, the
  // fingerprint changes and the "I've read this" goes amber again.
  const fp = crypto.createHash('sha1').update(JSON.stringify({
    d: date, m: [menu.lunch, menu.pudding, menu.allergens],
    c: clashes.map(x => [x.id, x.reasons.map(r => r.code).sort()]),
  })).digest('hex').slice(0, 16);
  const { rows } = await db.query(
    `SELECT ref, recorded_by, recorded_at FROM kitchen_events
      WHERE date = $1::date AND kind = 'allergens_read' ORDER BY recorded_at DESC LIMIT 1`, [date]);
  const ack = rows[0] ? { ref: rows[0].ref, by: rows[0].recorded_by, at_hhmm: londonHHMM(rows[0].recorded_at) } : null;
  return {
    date, menu: { lunch: menu.lunch, pudding: menu.pudding, allergens: menu.allergens, baby: menu.baby, weekend: menu.weekend },
    source: t.source, clashes, others, texture, fingerprint: fp,
    read: !!(ack && ack.ref === fp), last_read: ack,
  };
}
async function markAllergensRead(db, { date, fingerprint, user }) {
  const b = await allergenBoard(db, date);
  if (fingerprint && fingerprint !== b.fingerprint) {
    return { saved: false, changed: true, message: 'Something changed since you opened this screen. Please read it again.', board: b };
  }
  await db.query(
    `INSERT INTO kitchen_events (date, kind, ref, detail, recorded_by, recorded_by_id)
     VALUES ($1::date, 'allergens_read', $2, $3::jsonb, $4, $5)`,
    [date, b.fingerprint, JSON.stringify({ clashes: b.clashes.length, texture: b.texture.length }), whoName(user), user && user.id || null]);
  return { saved: true, at_hhmm: londonNow().hhmm, by: whoName(user) };
}

// ── served ──────────────────────────────────────────────────────────────────
async function servedStatus(db, date) {
  const { rows: ev } = await db.query(
    `SELECT recorded_by, recorded_at FROM kitchen_events
      WHERE date = $1::date AND kind = 'served' ORDER BY recorded_at DESC LIMIT 1`, [date]);
  if (ev[0]) return { done: true, at_hhmm: londonHHMM(ev[0].recorded_at), by: ev[0].recorded_by };
  const { rows: pl } = await db.query(
    `SELECT max(served_at) AS served_at FROM menu_plans
      WHERE week_start_date = $1::date AND day_of_week = $2 AND meal_type IN ('lunch','pudding')`,
    [mondayStr(date), dowOf(date)]);
  if (pl[0] && pl[0].served_at) return { done: true, at_hhmm: londonHHMM(pl[0].served_at), by: null };
  return { done: false };
}
async function markServed(db, { date, user }) {
  // Sets menu_plans.served_at on today's dated plans (every room), as the brief
  // asks, and records the tap itself — a day with no dated plan still gets a
  // "Served" and still turns her dot green.
  const { rowCount } = await db.query(
    `UPDATE menu_plans SET served_at = now(), status = 'served', updated_at = now()
      WHERE week_start_date = $1::date AND day_of_week = $2 AND meal_type IN ('lunch','pudding')
        AND served_at IS NULL`,
    [mondayStr(date), dowOf(date)]);
  await db.query(
    `INSERT INTO kitchen_events (date, kind, ref, detail, recorded_by, recorded_by_id)
     VALUES ($1::date, 'served', 'lunch', $2::jsonb, $3, $4)`,
    [date, JSON.stringify({ plans_updated: rowCount }), whoName(user), user && user.id || null]);
  return { saved: true, plans_updated: rowCount, at_hhmm: londonNow().hhmm };
}

// ── cleaning — only what is due today ───────────────────────────────────────
async function cleaningToday(db, date) {
  const { rows } = await db.query(`
    SELECT t.id, t.area, t.frequency, t.sort_order,
           l.done AS done_today, l.recorded_by, l.recorded_at,
           (SELECT max(e.date) FROM kitchen_cleaning_log e
             WHERE e.task_id = t.id AND e.done = true AND e.date < $1::date
               AND e.date >= CASE t.frequency WHEN 'weekly' THEN $2::date
                                              WHEN 'monthly' THEN $3::date
                                              ELSE $1::date END) AS done_earlier
      FROM kitchen_cleaning_tasks t
      LEFT JOIN kitchen_cleaning_log l ON l.task_id = t.id AND l.date = $1::date
     WHERE t.is_active = true
     ORDER BY CASE t.frequency WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END, t.sort_order, t.id`,
    [date, mondayStr(date), firstOfMonth(date)]);
  const tasks = rows
    .filter(r => r.frequency === 'daily' || !r.done_earlier)
    .map(r => ({
      id: r.id, area: r.area, frequency: r.frequency,
      when: r.frequency === 'daily' ? 'Every day' : r.frequency === 'weekly' ? 'This week' : 'This month',
      done: r.done_today === true, by: r.done_today ? r.recorded_by : null,
      at_hhmm: r.done_today ? londonHHMM(r.recorded_at) : null,
    }));
  const done = tasks.filter(t => t.done).length;
  return { date, tasks, done, due: tasks.length, all_done: tasks.length > 0 && done === tasks.length };
}
async function tickCleaning(db, { date, taskId, done, user }) {
  const { rows: t } = await db.query('SELECT id, area FROM kitchen_cleaning_tasks WHERE id = $1 AND is_active = true', [taskId]);
  if (!t[0]) throw httpError(404, 'cleaning task not found');
  await db.query(`
    INSERT INTO kitchen_cleaning_log (task_id, date, done, notes, recorded_by, recorded_at)
    VALUES ($1, $2::date, $3, NULL, $4, now())
    ON CONFLICT (task_id, date) DO UPDATE SET done = EXCLUDED.done, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
    [taskId, date, done !== false, whoName(user)]);
  // After noon a tick on "Floors swept & mopped" also answers the matching
  // end-of-day question, so she is not asked the same thing twice. It never
  // overwrites an answer she has already given.
  let crossFilled = 0;
  if (done !== false && londonNow().minutes >= 12 * 60) {
    for (const d of CHECKS.closing) {
      if (!d.cleaning || !d.cleaning.test(t[0].area)) continue;
      const r = await db.query(`
        INSERT INTO sfbb_records (date, shift, section, item, checked, value_text, notes, recorded_by, recorded_at)
        VALUES ($1::date, 'closing', $2, $3, true, 'Yes', 'Ticked on the cleaning list', $4, now())
        ON CONFLICT (date, shift, section, item) DO NOTHING`,
        [date, d.section, d.item, whoName(user)]);
      crossFilled += r.rowCount;
    }
  }
  // Unticked again after noon: take back only the answer this function wrote
  // (identified by its note) — set it unanswered, never delete the row.
  if (done === false) {
    for (const d of CHECKS.closing) {
      if (!d.cleaning || !d.cleaning.test(t[0].area)) continue;
      await db.query(`
        UPDATE sfbb_records SET checked = false, value_text = NULL, notes = 'Unticked on the cleaning list',
               recorded_by = $4, recorded_at = now()
         WHERE date = $1::date AND shift = 'closing' AND section = $2 AND item = $3
           AND notes = 'Ticked on the cleaning list'`,
        [date, d.section, d.item, whoName(user)]);
    }
  }
  return { saved: true, cross_filled: crossFilled };
}

// ── fridge / freezer sensors ────────────────────────────────────────────────
// Only the automatic probe counts (source <> 'manual'). The flag:
//   - no reading for 2 hours                          -> 'stale'
//   - above the limit continuously for over an hour  -> 'too_warm'
//   - above the limit for less than an hour           -> 'warming' (door open, delivery)
async function sensorStatus(db, limits) {
  limits = limits || await getLimits(db);
  const out = [];
  for (const location of ['fridge', 'freezer']) {
    const max = limitFor(location, limits);
    const Label = location === 'fridge' ? 'Fridge' : 'Freezer';
    const { rows: last } = await db.query(`
      SELECT reading_c, recorded_at,
             EXTRACT(EPOCH FROM (localtimestamp - recorded_at)) / 60 AS age_min
        FROM kitchen_sensor_readings
       WHERE location = $1 AND COALESCE(source, '') <> 'manual'
       ORDER BY recorded_at DESC LIMIT 1`, [location]);
    const s = { location, label: Label, limit: max, flagged: false };
    if (!last[0]) {
      Object.assign(s, { status: 'stale', flagged: true, reading: null,
        title: `${Label} probe needs checking`,
        detail: `The ${location} probe has never sent a reading to Wren.` });
      out.push(s); continue;
    }
    const reading = Number(last[0].reading_c);
    const age = Math.round(Number(last[0].age_min));
    s.reading = reading;
    s.at_hhmm = londonHHMM(last[0].recorded_at);
    s.age_minutes = age;
    if (age > limits.sensor_stale_minutes) {
      Object.assign(s, { status: 'stale', flagged: true,
        title: `${Label} probe needs checking`,
        detail: `No reading from the ${location} probe for ${age >= 120 ? Math.round(age / 60) + ' hours' : age + ' minutes'} (last: ${reading}°C at ${s.at_hhmm}${age > 1440 ? ' on ' + isoDate(last[0].recorded_at) : ''}). The probe or the Home Assistant feed may be down.` });
    } else if (reading > max) {
      const { rows: since } = await db.query(`
        SELECT min(recorded_at) AS first_bad,
               EXTRACT(EPOCH FROM (localtimestamp - min(recorded_at))) / 60 AS warm_min
          FROM kitchen_sensor_readings
         WHERE location = $1 AND COALESCE(source, '') <> 'manual' AND reading_c > $2
           AND recorded_at > COALESCE(
                 (SELECT max(recorded_at) FROM kitchen_sensor_readings
                   WHERE location = $1 AND COALESCE(source, '') <> 'manual' AND reading_c <= $2
                     AND recorded_at > localtimestamp - interval '2 days'),
                 localtimestamp - interval '2 days')`, [location, max]);
      const warm = Math.round(Number(since[0] && since[0].warm_min) || 0);
      s.warm_minutes = warm;
      if (warm >= limits.sensor_warm_minutes) {
        Object.assign(s, { status: 'too_warm', flagged: true,
          title: `${Label} probe needs checking`,
          detail: `The ${location} probe has read above ${max}°C for ${warm >= 120 ? Math.round(warm / 60) + ' hours' : warm + ' minutes'} (now ${reading}°C). Check it with the hand thermometer.` });
      } else {
        Object.assign(s, { status: 'warming', title: `${Label} ${reading}°C just now`, detail: `Above ${max}°C for ${warm} minutes.` });
      }
    } else {
      Object.assign(s, { status: 'ok', title: `${Label} probe ${reading}°C`, detail: `Reading at ${s.at_hhmm}.` });
    }
    out.push(s);
  }
  return out;
}

// ── shopping ────────────────────────────────────────────────────────────────
async function shoppingState(db, date) {
  const { rows: favs } = await db.query(
    `SELECT id, name, unit FROM kitchen_shopping_favourites WHERE is_active = true ORDER BY sort_order, name`);
  const { rows: sent } = await db.query(
    `SELECT id, status, items_json, ordered_by, created_at, note FROM shopping_lists
      WHERE source = 'favourites' AND week_start_date = $1::date ORDER BY created_at DESC`, [mondayStr(date)]);
  return {
    favourites: favs,
    sent_this_week: sent.map(s => ({
      id: s.id, status: s.status, by: s.ordered_by, note: s.note,
      day: DOW[new Date(s.created_at).getDay()], at_hhmm: londonHHMM(s.created_at),
      count: Array.isArray(s.items_json) ? s.items_json.length : 0,
      items: Array.isArray(s.items_json) ? s.items_json : [],
    })),
  };
}
async function sendShopping(db, { date, items, note, user }) {
  if (!Array.isArray(items) || !items.length) throw httpError(400, 'the list is empty');
  if (items.length > 80) throw httpError(400, 'that list is too long');
  const clean = [];
  const seen = new Set();
  for (const it of items) {
    const name = String((it && it.name) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const qty = parseInt(it && it.qty, 10);
    if (!name || !Number.isFinite(qty) || qty < 1) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push({ name, qty: Math.min(qty, 99), unit: it.unit ? String(it.unit).slice(0, 30) : null,
                 favourite_id: Number.isFinite(parseInt(it.favourite_id, 10)) ? parseInt(it.favourite_id, 10) : null });
  }
  if (!clean.length) throw httpError(400, 'the list is empty');
  const { rows } = await db.query(`
    INSERT INTO shopping_lists (week_start_date, room, items_json, status, supplier, ordered_by, source, sent_by_id, note)
    VALUES ($1::date, 'all', $2::jsonb, 'sent', NULL, $3, 'favourites', $4, $5)
    RETURNING id, created_at`,
    [mondayStr(date), JSON.stringify(clean), whoName(user), user && user.id || null, note ? String(note).trim().slice(0, 300) : null]);
  return { id: rows[0].id, count: clean.length, at_hhmm: londonHHMM(rows[0].created_at) };
}

// ── the home screen: five buttons and their dots ────────────────────────────
async function homeState(db, user) {
  const now = londonNow();
  const date = now.date;
  const limits = await getLimits(db);
  const shift = now.minutes < 12 * 60 ? 'opening' : 'closing';
  const [checks, sensors, cleaning, served, cookTemp, allergens, shop, probe] = await Promise.all([
    checksStatus(db, date, limits), sensorStatus(db, limits), cleaningToday(db, date),
    servedStatus(db, date), cookingTempToday(db, date), allergenBoard(db, date),
    db.query(`SELECT created_at FROM shopping_lists WHERE source = 'favourites' AND week_start_date = $1::date
               ORDER BY created_at DESC LIMIT 1`, [mondayStr(date)]),
    probeThisWeek(db, date),
  ]);
  const flagged = sensors.filter(s => s.flagged);
  const lastShop = shop.rows[0];

  const checksDone = shift === 'opening' ? checks.opening.done : (checks.opening.done && checks.closing.done);
  let checksLabel;
  if (shift === 'opening') checksLabel = checks.opening.done ? `Morning checks done at ${checks.opening.completed_hhmm}` : 'Morning checks to do';
  else if (!checks.opening.done) checksLabel = 'Morning checks were missed';
  else checksLabel = checks.closing.done ? `End of day checks done at ${checks.closing.completed_hhmm}` : 'End of day checks to do';

  const noMenu = !allergens.menu.lunch && !allergens.menu.pudding;
  let allergenLabel, allergenDone;
  if (allergens.menu.weekend) { allergenLabel = 'No menu today'; allergenDone = true; }
  else if (noMenu) { allergenLabel = 'No menu for today — ask Toby'; allergenDone = false; }
  else if (!allergens.clashes.length) { allergenLabel = 'No clashes with today\'s food'; allergenDone = true; }
  else if (allergens.read) { allergenLabel = `${allergens.clashes.length} to watch — read at ${allergens.last_read.at_hhmm}`; allergenDone = true; }
  else { allergenLabel = `${allergens.clashes.length} ${allergens.clashes.length === 1 ? 'child' : 'children'} to watch — tap to read`; allergenDone = false; }

  return {
    date, day_label: londonDayLabel(date), time: now.hhmm, shift, weekday: isWeekday(date),
    name: firstName(whoName(user)),
    buttons: {
      cooking: { done: served.done, label: served.done ? `Served at ${served.at_hhmm}` : (noMenu ? 'No menu for today' : 'Not served yet'),
                 sub: allergens.menu.lunch || null },
      allergens: { done: allergenDone, label: allergenLabel, clashes: allergens.clashes.length },
      shopping: { done: !!lastShop, label: lastShop ? `Sent ${DOW[new Date(lastShop.created_at).getDay()]} at ${londonHHMM(lastShop.created_at)}` : 'Not sent this week' },
      checks: { done: checksDone && !flagged.length, label: flagged.length ? flagged.map(s => s.title).join(' · ') : checksLabel,
                warn: flagged.length > 0, checks_label: checksLabel },
      cleaning: { done: cleaning.all_done || cleaning.due === 0, label: cleaning.due === 0 ? 'Nothing due today' : (cleaning.all_done ? 'All done' : `${cleaning.done} of ${cleaning.due} done`),
                  done_count: cleaning.done, due_count: cleaning.due },
    },
    sensors: sensors.map(s => ({ location: s.location, status: s.status, flagged: s.flagged, title: s.title, reading: s.reading == null ? null : s.reading, at_hhmm: s.at_hhmm || null })),
    extras: { cooking_temp: cookTemp, probe },
  };
}

// ── missed checks + alerts (collector and kitchen-watch) ────────────────────
async function bankHolidays(db, from, to) {
  try {
    const { rows } = await db.query(
      `SELECT holiday_date FROM bank_holidays WHERE holiday_date BETWEEN $1::date AND $2::date`, [from, to]);
    return new Set(rows.map(r => isoDate(r.holiday_date)));
  } catch { return new Set(); }
}
// Missed checks on nursery days in the last 7 days (today included once it is
// past 10:00 / 17:30). Days before kitchen_checks_alert_from never count.
async function missedChecks(db, now, limits) {
  now = now || londonNow();
  limits = limits || await getLimits(db);
  const from = await getSetting(db, 'kitchen_checks_alert_from', null);
  const today = now.date;
  const first = addDays(today, -6);
  const bh = await bankHolidays(db, first, today);
  const { rows } = await db.query(
    `SELECT date, shift, section, item, checked, value_text, notes, recorded_by, recorded_at
       FROM sfbb_records WHERE date BETWEEN $1::date AND $2::date`, [first, today]);
  const byDate = new Map();
  for (const r of rows) {
    const d = isoDate(r.date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    if (!isWeekday(d) || bh.has(d) || (from && validDate(from) && d < from)) continue;
    const s = summariseChecks(byDate.get(d) || [], limits);
    const past = d < today;
    if (!s.opening.done && (past || now.minutes >= OPENING_DUE_MIN)) out.push({ date: d, shift: 'opening', answered: s.opening.answered, total: s.opening.total, today: !past });
    if (!s.closing.done && (past || now.minutes >= CLOSING_DUE_MIN)) out.push({ date: d, shift: 'closing', answered: s.closing.answered, total: s.closing.total, today: !past });
  }
  return out;
}
async function problemsToday(db, date, limits) {
  const checks = await checksStatus(db, date, limits);
  const list = [...checks.opening.problems, ...checks.closing.problems].map(p => p.what);
  const logs = await logsForDate(db, date);
  for (const l of logs) {
    if (l.ok !== false) continue;
    if (l.kind === 'delivery') list.push(`Delivery from ${l.supplier || 'a supplier'} ${l.temp_c != null ? '(' + Number(l.temp_c) + '°C) ' : ''}not accepted or too warm`);
    else if (l.kind === 'hot_holding') list.push(`Food kept hot only ${Number(l.temp_c)}°C`);
    else if (l.kind === 'cooling') list.push('Food took too long to cool');
    else if (l.kind === 'probe_calibration') list.push(`Probe check failed (ice ${Number(l.temp_c)}°C, boiling ${Number(l.temp2_c)}°C)`);
  }
  const ct = await cookingTempToday(db, date);
  if (ct.temp != null && !ct.done) list.push(`Cooking temperature ${ct.temp}°C (below ${(limits || DEFAULT_LIMITS).cook_min}°C)`);
  return list;
}
async function currentAlerts(db) {
  const now = londonNow();
  const limits = await getLimits(db);
  const out = [];
  for (const m of (await missedChecks(db, now, limits)).filter(x => x.today)) {
    out.push({
      key: `${m.shift}-missed:${m.date}`, date: now.date, category: 'kitchen_check_missed',
      title: m.shift === 'opening' ? 'Kitchen morning checks not done' : 'Kitchen end-of-day checks not done',
      body: `${m.shift === 'opening' ? 'The Safer Food Better Business opening checks were due by 10:00' : 'The closing checks were due by 17:30'} — ${m.answered} of ${m.total} answered so far.`,
      link: '/kitchen-sfbb-review.html',
    });
  }
  for (const s of (await sensorStatus(db, limits)).filter(x => x.flagged)) {
    out.push({
      key: `sensor-${s.status}:${s.location}:${now.date}`, date: now.date, category: 'kitchen_sensor_problem',
      title: s.title, body: s.detail, link: '/kitchen.html',
    });
  }
  return out;
}

// ── four-weekly review (manager, Roost) ─────────────────────────────────────
async function reviewPeriod(db, endDate) {
  const limits = await getLimits(db);
  const end = endDate;
  const start = addDays(end, -27);
  const [sfbb, cooking, logs, clog, tasks, events, bh, reviews, sensor, sensorNow] = await Promise.all([
    db.query(`SELECT date, shift, section, item, checked, value_text, notes, recorded_by, recorded_at
                FROM sfbb_records WHERE date BETWEEN $1::date AND $2::date`, [start, end]),
    db.query(`SELECT date, food_name, temp_c, created_at FROM kitchen_cooking_temps
               WHERE date BETWEEN $1::date AND $2::date ORDER BY created_at`, [start, end]),
    db.query(`SELECT date, kind, food, supplier, temp_c, temp2_c, ok, notes, recorded_by, recorded_at
                FROM kitchen_sfbb_log WHERE date BETWEEN $1::date AND $2::date ORDER BY recorded_at`, [start, end]),
    db.query(`SELECT l.task_id, l.date, l.done FROM kitchen_cleaning_log l
               WHERE l.date BETWEEN $1::date AND $2::date AND l.done = true`, [start, end]),
    db.query(`SELECT id, area, frequency FROM kitchen_cleaning_tasks WHERE is_active = true ORDER BY sort_order, id`),
    db.query(`SELECT date, kind, recorded_by, recorded_at FROM kitchen_events
               WHERE date BETWEEN $1::date AND $2::date AND kind IN ('served','allergens_read')`, [start, end]),
    bankHolidays(db, start, end),
    db.query(`SELECT id, period_start, period_end, problems_found, actions_taken, changes, reviewed_by, reviewed_at
                FROM kitchen_sfbb_reviews ORDER BY period_end DESC LIMIT 12`),
    db.query(`SELECT location, count(*)::int AS n,
                     count(*) FILTER (WHERE (location = 'fridge' AND reading_c > $3) OR (location = 'freezer' AND reading_c > $4))::int AS over
                FROM kitchen_sensor_readings
               WHERE COALESCE(source, '') <> 'manual'
                 AND recorded_at >= $1::date AND recorded_at < ($2::date + 1)
               GROUP BY location`, [start, end, limits.fridge_max, limits.freezer_max]),
    sensorStatus(db, limits),
  ]);

  const group = (rows, f) => { const m = new Map(); for (const r of rows) { const k = f(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const sfbbBy = group(sfbb.rows, r => isoDate(r.date));
  const cookBy = group(cooking.rows, r => isoDate(r.date));
  const logBy = group(logs.rows, r => isoDate(r.date));
  const evBy = group(events.rows, r => isoDate(r.date));
  const dailyTasks = tasks.rows.filter(t => t.frequency === 'daily');
  const doneBy = group(clog.rows, r => isoDate(r.date));

  const days = [], problems = [];
  let openingDone = 0, closingDone = 0, nurseryDays = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (!isWeekday(d)) continue;
    const holiday = bh.has(d);
    const s = summariseChecks(sfbbBy.get(d) || [], limits);
    const cooks = (cookBy.get(d) || []).map(c => ({ food: c.food_name, temp: Number(c.temp_c), ok: Number(c.temp_c) >= limits.cook_min, at_hhmm: londonHHMM(c.created_at) }));
    const ev = evBy.get(d) || [];
    const doneIds = new Set((doneBy.get(d) || []).map(r => r.task_id));
    const dailyDone = dailyTasks.filter(t => doneIds.has(t.id)).length;
    if (!holiday) {
      nurseryDays++;
      if (s.opening.done) openingDone++;
      if (s.closing.done) closingDone++;
    }
    for (const p of [...s.opening.problems, ...s.closing.problems]) problems.push({ date: d, what: p.what, notes: p.notes });
    for (const c of cooks) if (!c.ok) problems.push({ date: d, what: `Cooking temperature ${c.temp}°C (${c.food})`, notes: null });
    for (const l of logBy.get(d) || []) if (l.ok === false) problems.push({ date: d, what: `${l.kind.replace('_', ' ')}: ${l.food || l.supplier || ''} ${l.temp_c != null ? Number(l.temp_c) + '°C' : ''}`.trim(), notes: l.notes });
    const t = (shift, key) => { const a = s[shift].answers[key]; return a && a.answered ? { value: a.value, problem: a.problem } : null; };
    days.push({
      date: d, label: shortDayLabel(d), holiday,
      opening: { done: s.opening.done, answered: s.opening.answered, total: s.opening.total, at_hhmm: s.opening.completed_hhmm, by: s.opening.completed_by },
      closing: { done: s.closing.done, answered: s.closing.answered, total: s.closing.total, at_hhmm: s.closing.completed_hhmm, by: s.closing.completed_by },
      fridge_am: t('opening', 'fridge'), fridge_pm: t('closing', 'fridge'),
      freezer_am: t('opening', 'freezer'), freezer_pm: t('closing', 'freezer'),
      pests_ok: s.opening.answers.pests && s.opening.answers.pests.answered ? !s.opening.answers.pests.problem : null,
      cooking: cooks,
      served: ev.some(e => e.kind === 'served'),
      allergens_read: ev.some(e => e.kind === 'allergens_read'),
      cleaning: { done: dailyDone, due: dailyTasks.length },
    });
  }

  const weeks = [];
  for (let w = mondayStr(start); w <= end; w = addDays(w, 7)) {
    const wEnd = addDays(w, 6);
    const inWeek = logs.rows.filter(l => { const d = isoDate(l.date); return d >= w && d <= wEnd; });
    const probe = inWeek.filter(l => l.kind === 'probe_calibration');
    const weekly = tasks.rows.filter(t => t.frequency === 'weekly').map(t => ({
      area: t.area, done: clog.rows.some(r => r.task_id === t.id && isoDate(r.date) >= w && isoDate(r.date) <= wEnd),
    }));
    weeks.push({ week_start: w, probe_done: probe.length > 0, probe_ok: probe.length ? probe.every(p => p.ok) : null, weekly_cleaning: weekly });
  }

  return {
    period: { start, end, label: `${shortDayLabel(start)} – ${shortDayLabel(end)}` },
    limits,
    totals: {
      nursery_days: nurseryDays, opening_done: openingDone, closing_done: closingDone,
      problems: problems.length,
      deliveries: logs.rows.filter(l => l.kind === 'delivery').length,
      hot_holding: logs.rows.filter(l => l.kind === 'hot_holding').length,
      cooling: logs.rows.filter(l => l.kind === 'cooling').length,
      probe_weeks: weeks.filter(w => w.probe_done).length, weeks: weeks.length,
      cooking_temps: cooking.rows.length,
    },
    days, weeks, problems,
    logs: logs.rows.map(l => ({ date: isoDate(l.date), kind: l.kind, food: l.food, supplier: l.supplier,
      temp_c: l.temp_c == null ? null : Number(l.temp_c), temp2_c: l.temp2_c == null ? null : Number(l.temp2_c),
      ok: l.ok, notes: l.notes, by: l.recorded_by, at_hhmm: londonHHMM(l.recorded_at) })),
    sensor: { period: sensor.rows, now: sensorNow.map(s => ({ location: s.location, status: s.status, flagged: s.flagged, title: s.title, detail: s.detail })) },
    review: reviews.rows.find(r => isoDate(r.period_start) === start && isoDate(r.period_end) === end) || null,
    past_reviews: reviews.rows.map(r => ({ id: r.id, period_start: isoDate(r.period_start), period_end: isoDate(r.period_end),
      reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at, problems_found: r.problems_found, actions_taken: r.actions_taken, changes: r.changes })),
  };
}
async function saveReview(db, { start, end, body, user }) {
  const t = v => (v == null ? null : String(v).trim().slice(0, 4000) || null);
  const { rows } = await db.query(`
    INSERT INTO kitchen_sfbb_reviews (period_start, period_end, problems_found, actions_taken, changes, reviewed_by, reviewed_by_id, reviewed_at)
    VALUES ($1::date, $2::date, $3, $4, $5, $6, $7, now())
    ON CONFLICT (period_start, period_end) DO UPDATE SET
      problems_found = EXCLUDED.problems_found, actions_taken = EXCLUDED.actions_taken, changes = EXCLUDED.changes,
      reviewed_by = EXCLUDED.reviewed_by, reviewed_by_id = EXCLUDED.reviewed_by_id, reviewed_at = now()
    RETURNING id, reviewed_at`,
    [start, end, t(body.problems_found), t(body.actions_taken), t(body.changes), whoName(user), user && user.id || null]);
  return { id: rows[0].id, reviewed_at: rows[0].reviewed_at };
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = {
  TZ, LIMITS: DEFAULT_LIMITS, CHECKS, SHIFT_LABEL, OPENING_DUE_MIN, CLOSING_DUE_MIN,
  londonNow, londonHHMM, londonDayLabel, shortDayLabel, isoDate, addDays, dowOf, mondayStr, validDate, isWeekday,
  whoName, firstName, getSetting, getLimits, limitFor, alertStaffId,
  ensureSchema, extendLegacyChecklist, publicChecks,
  summariseChecks, checksStatus, saveCheckAnswer, noteCheckAnswer,
  saveLog, logsForDate, probeThisWeek, saveCookingTemp, cookingTempToday,
  todaysMenu, weekMenu, splitLunchLine, childrenToday, portionsToday,
  childClashes, allergenBoard, markAllergensRead, servedStatus, markServed,
  cleaningToday, tickCleaning, sensorStatus, shoppingState, sendShopping,
  homeState, missedChecks, problemsToday, currentAlerts, reviewPeriod, saveReview, httpError,
};
