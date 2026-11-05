'use strict';
/* ===========================================================================
 * src/lib/kitchen-shop.js — b540 (2026-11-02)
 *
 * the chef's Sainsbury's list. Toby: "get the kitchen ready for Sainsbury's
 * orders and the chef using it".
 *
 * WHAT IT DOES
 * Builds one week's shopping list from three things Wren already knows:
 *   1. the menu for each weekday (the rotation, via kitchen-simple.weekMenu);
 *   2. how many children are expected each day — COUNTS ONLY, via
 *      kitchen-simple.portionsToday (the register, or bookings when the
 *      register for that day has not started yet). No child name or allergy
 *      text is read or returned by anything in this file;
 *   3. portion rules: "a dish that mentions X needs Y grams of Z per child,
 *      and Z comes in packs of P" (ladn.kitchen_shop_rules, seeded below,
 *      editable by a manager).
 * Plus the nursery's own "regular weekly items" (transcribed in b404 from the
 * nursery's paper sheet, confirmed by Toby as not personal data), minus
 * anything the chef has ticked "We have it" this week.
 *
 * WHAT IT DOES NOT DO — and will not
 * It does not log in to Sainsbury's, place an order, or read their website.
 * Sainsbury's publish no ordering API for a customer this size and their
 * terms prohibit automated extraction (see src/lib/sainsburys-sku.js). Every
 * item instead carries a link to a Sainsbury's SEARCH page for its name, and
 * — once she has picked a product she likes — the link she pasted, so next
 * week the button goes straight to "her usual". That is the "it learns" part:
 * kitchen_shop_choices remembers the product per item, by her hand.
 * =========================================================================== */

const K = require('./kitchen-simple');
const SKU = require('./sainsburys-sku');

const AISLES = [
  'Fruit & veg', 'Meat, fish & Quorn', 'Dairy, eggs & chilled', 'Bakery',
  'Frozen', 'Food cupboard', 'Baby & toddler', 'Household',
];

const SEARCH_BASE = 'https://www.sainsburys.co.uk/gol-ui/SearchResults/';
function searchUrl(term) { return SEARCH_BASE + encodeURIComponent(String(term || '').trim()); }

// ── portion rules (seed) ────────────────────────────────────────────────────
// [keyword(s) '|'-separated, not-phrases '|'-separated or '', item, aisle,
//  per_child, unit, pack_size, pack_label, search term]
// Amounts are calibrated against the nursery's own weekly sheet (b404: e.g.
// "potatoes 1.5 bags per meal", "custard 2 cartons per meal") for ~45 children,
// so they are per-child shares of a whole-nursery batch. The list adds 10% spare
// on top and always rounds UP to whole packs. Baby Room portions are smaller,
// so the total over-orders slightly — Toby: "better to over-order than too
// little" (the nursery's own sheet, b404).
const RULES = [
  // carbs
  ['rice', 'rice pudding', 'Long grain rice', 'Food cupboard', 25, 'g', 1000, '1kg bag', 'long grain rice 1kg'],
  ['pasta|spaghetti|macaroni', '', 'Pasta', 'Food cupboard', 25, 'g', 500, '500g bag', 'pasta 500g'],
  ['noodles', '', 'Noodles', 'Food cupboard', 15, 'g', 300, '300g pack', 'medium noodles'],
  ['couscous', '', 'Couscous', 'Food cupboard', 15, 'g', 500, '500g bag', 'couscous 500g'],
  ['mash|potato|fish pie|shepherd', 'sweet potato', 'Potatoes', 'Fruit & veg', 75, 'g', 2500, '2.5kg bag', 'white potatoes 2.5kg'],
  ['chips', '', 'Oven chips', 'Frozen', 60, 'g', 1500, '1.5kg bag', 'oven chips 1.5kg'],
  ['lasagne', '', 'Lasagne sheets', 'Food cupboard', 15, 'g', 250, '250g box', 'lasagne sheets'],
  ['dumpling', '', 'Vegetable suet', 'Food cupboard', 4, 'g', 200, '200g box', 'vegetable suet'],
  ['dumpling|cake|traybake', '', 'Self-raising flour', 'Food cupboard', 15, 'g', 1500, '1.5kg bag', 'self raising flour 1.5kg'],
  ['pastries|pastry', '', 'Ready-rolled puff pastry', 'Dairy, eggs & chilled', 15, 'g', 320, '320g sheet', 'ready rolled puff pastry'],
  // vegetables
  ['peas', '', 'Frozen peas', 'Frozen', 12, 'g', 900, '900g bag', 'frozen garden peas'],
  ['broccoli', '', 'Broccoli', 'Fruit & veg', 10, 'g', 350, 'head', 'broccoli'],
  ['carrot', '', 'Carrots', 'Fruit & veg', 12, 'g', 1000, '1kg bag', 'carrots 1kg'],
  ['sweetcorn', '', 'Sweetcorn (tins)', 'Food cupboard', 12, 'g', 198, '198g tin', 'sweetcorn tin'],
  ['spinach', '', 'Frozen spinach', 'Frozen', 10, 'g', 900, '900g bag', 'frozen spinach'],
  ['courgette', '', 'Courgettes', 'Fruit & veg', 16, 'g', 250, 'each', 'courgettes'],
  ['mushroom', '', 'Mushrooms', 'Fruit & veg', 7, 'g', 300, '300g pack', 'closed cup mushrooms'],
  ['sweet potato', '', 'Sweet potatoes', 'Fruit & veg', 20, 'g', 1000, '1kg bag', 'sweet potatoes'],
  ['butternut', '', 'Butternut squash (prepared)', 'Fruit & veg', 10, 'g', 450, '450g pack', 'butternut squash chunks'],
  ['swede', '', 'Swede', 'Fruit & veg', 12, 'g', 600, 'each', 'swede'],
  ['mediterranean', '', 'Peppers (mixed)', 'Fruit & veg', 15, 'g', 500, 'pack of 3', 'mixed peppers'],
  ['chinese vegetables|stir fry', '', 'Stir-fry vegetables', 'Fruit & veg', 7, 'g', 300, '300g pack', 'stir fry vegetables'],
  ['vegetable curry|vegetable stew|vegetable noodles|tagine|casserole', '', 'Frozen mixed vegetables', 'Frozen', 11, 'g', 1000, '1kg bag', 'frozen mixed vegetables'],
  // tins & sauces
  ['curry|chilli|bolognese|lasagne|tagine|stew|casserole|dhal|tomato', '', 'Chopped tomatoes (tins)', 'Food cupboard', 20, 'g', 400, '400g tin', 'chopped tomatoes 400g'],
  ['chickpea|tagine', '', 'Chickpeas (tins)', 'Food cupboard', 20, 'g', 240, '400g tin', 'chickpeas in water'],
  ['lentil|dhal', '', 'Red lentils', 'Food cupboard', 15, 'g', 500, '500g bag', 'red split lentils'],
  ['chilli|five bean', '', 'Mixed beans (tins)', 'Food cupboard', 25, 'g', 400, '400g tin', 'mixed beans in water'],
  ['baked beans', '', 'Baked beans', 'Food cupboard', 55, 'g', 415, '415g tin', 'baked beans reduced sugar'],
  ['coconut', '', 'Coconut milk (tins)', 'Food cupboard', 15, 'ml', 400, '400ml tin', 'coconut milk 400ml'],
  ['sweet and sour', '', 'Sweet and sour sauce', 'Food cupboard', 22, 'g', 500, '500g jar', 'sweet and sour sauce jar'],
  ['barbecue|bbq', '', 'Barbecue sauce', 'Food cupboard', 10, 'g', 480, 'bottle', 'barbecue sauce'],
  ['macaroni|cheese|pasta bake|lasagne', '', 'Cheese sauce mix', 'Food cupboard', 0.09, 'each', 1, 'packet', 'cheese sauce mix'],
  // protein
  ['quorn', '', 'Quorn pieces', 'Frozen', 20, 'g', 300, '300g pack', 'quorn pieces'],
  ['beef|bolognese|lasagne', '', 'Beef mince', 'Meat, fish & Quorn', 25, 'g', 500, '500g pack', 'beef mince 5% fat 500g'],
  ['lamb|shepherd', '', 'Lamb mince', 'Meat, fish & Quorn', 25, 'g', 500, '500g pack', 'lamb mince 500g'],
  ['salmon', '', 'Salmon fillets', 'Meat, fish & Quorn', 8, 'g', 360, '360g pack', 'boneless salmon fillets'],
  ['fish pie', '', 'Fish pie mix', 'Meat, fish & Quorn', 14, 'g', 320, '320g pack', 'fish pie mix'],
  ['tuna', '', 'Tuna (tins)', 'Food cupboard', 22, 'g', 340, '340g tin', 'tuna chunks in spring water'],
  ['fish finger', '', 'Fish fingers', 'Frozen', 1.5, 'each', 30, 'box of 30', 'fish fingers 30'],
  ['vegetable finger', '', 'Vegetable fingers', 'Frozen', 0.7, 'each', 10, 'box of 10', 'vegetable fingers'],
  // puddings
  ['custard', '', 'Custard (1kg cartons)', 'Dairy, eggs & chilled', 45, 'g', 1000, '1kg carton', 'custard 1kg'],
  ['yoghurt|yogurt', '', 'Greek-style yoghurt', 'Dairy, eggs & chilled', 33, 'g', 500, '500g tub', 'greek style yogurt 500g'],
  ['rhubarb', '', 'Rhubarb (tins)', 'Food cupboard', 36, 'g', 540, 'tin', 'rhubarb in syrup tin'],
  ['strawberr', 'strawberry whip', 'Strawberries', 'Fruit & veg', 15, 'g', 400, '400g punnet', 'strawberries'],
  ['blueberr', '', 'Blueberries', 'Fruit & veg', 10, 'g', 150, '150g punnet', 'blueberries'],
  ['raspberr', '', 'Raspberries', 'Fruit & veg', 10, 'g', 150, '150g punnet', 'raspberries'],
  ['blackberr', '', 'Blackberries', 'Fruit & veg', 10, 'g', 150, '150g punnet', 'blackberries'],
  ['berries|berry', '', 'Frozen mixed berries', 'Frozen', 15, 'g', 500, '500g bag', 'frozen mixed berries'],
  ['apple', '', 'Cooking apples', 'Fruit & veg', 27, 'g', 200, 'each', 'bramley cooking apples'],
  ['banana', '', 'Bananas', 'Fruit & veg', 0.2, 'each', 5, 'bunch of 5', 'bananas'],
  ['fruit salad', '', 'Fresh fruit for fruit salad', 'Fruit & veg', 60, 'g', 1000, 'about 1kg', 'fruit salad'],
  ['whip', '', 'Dessert whip (sachets)', 'Food cupboard', 0.17, 'each', 1, 'sachet', 'angel delight'],
  ['jelly', '', 'Jelly', 'Food cupboard', 0.07, 'each', 1, 'pack', 'jelly'],
  ['rice pudding', '', 'Pudding rice', 'Food cupboard', 11, 'g', 500, '500g bag', 'pudding rice'],
  ['semolina', '', 'Semolina', 'Food cupboard', 11, 'g', 500, '500g bag', 'semolina'],
  ['honey', '', 'Honey (squeezy)', 'Food cupboard', 5, 'g', 340, 'bottle', 'squeezy honey'],
  ['cake|traybake', '', 'Eggs', 'Dairy, eggs & chilled', 0.1, 'each', 12, 'box of 12', 'free range eggs 12'],
];

// ── the nursery's regular weekly items (b404 sheet) ─────────────────────────
// [name, quantity text, aisle, section]. Kept as text quantities on purpose:
// these are what the chef's paper sheet says, not something to compute.
const STAPLES = [
  ['Bananas', '4 packs (2 more if banana custard)', 'Fruit & veg', 'weekly'],
  ['Fresh fruit (apples, oranges, pears)', 'About 10 apples, 6 oranges, 6 pears', 'Fruit & veg', 'weekly'],
  ['Onions', '8', 'Fruit & veg', 'weekly'],
  ['Cucumber', '4', 'Fruit & veg', 'weekly'],
  ['Cocktail sausages', 'Pack of 40', 'Meat, fish & Quorn', 'weekly'],
  ['Cheese', '2 large (1kg) packs', 'Dairy, eggs & chilled', 'weekly'],
  ['Cheese spread', '6 tubs', 'Dairy, eggs & chilled', 'weekly'],
  ['Houmous', '3 tubs', 'Dairy, eggs & chilled', 'weekly'],
  ['"Free from" spread', '3 tubs', 'Dairy, eggs & chilled', 'weekly'],
  ['Milk', '1 semi-skimmed, 2 full fat', 'Dairy, eggs & chilled', 'weekly'],
  ['Yoghurt / fromage frais', '1 per child, plus extra for puddings', 'Dairy, eggs & chilled', 'weekly'],
  ['Pizza (Friday tea)', '5', 'Frozen', 'weekly'],
  ['Raisins', '1 pack', 'Food cupboard', 'weekly'],
  ['Dried apricots', '1 pack', 'Food cupboard', 'weekly'],
  ['Pasta sauce', '4 jars', 'Food cupboard', 'weekly'],
  ['Chopped tomatoes / passata', '8 packs', 'Food cupboard', 'weekly'],
  ['Fruit pots', '1 pack', 'Food cupboard', 'weekly'],
  ['Crackers / biscuits', 'About 15 packs in total', 'Food cupboard', 'weekly'],
  ['Scotch pancakes', '2', 'Bakery', 'weekly'],
  ['Bagels', '2', 'Bakery', 'weekly'],
  ['Fruit bread', '2', 'Bakery', 'weekly'],
  ['Sliced bread', '4 or 5', 'Bakery', 'weekly'],
  ['Pitta bread', '2 brown, 1 white', 'Bakery', 'weekly'],
  ['Tortilla wraps', '1 brown, 1 white', 'Bakery', 'weekly'],
  ['Warburtons thins', '2', 'Bakery', 'weekly'],
  ["Babies' snacks", 'About 12 assorted packs', 'Baby & toddler', 'weekly'],
  ['Vegetable gravy granules', '', 'Food cupboard', 'check'],
  ['Vegetable stock cubes', '', 'Food cupboard', 'check'],
  ['Marmite', '', 'Food cupboard', 'check'],
  ['Jam', '', 'Food cupboard', 'check'],
  ['Soreen (for allergies)', '', 'Bakery', 'check'],
  ['Tea bags', '', 'Food cupboard', 'check'],
  ['Coffee', '', 'Food cupboard', 'check'],
  ['Sugar', '', 'Food cupboard', 'check'],
  ['Cooking oil', '', 'Food cupboard', 'check'],
  ['Nappies, wipes, Sudocrem, nappy sacks', 'Ask the Baby Room', 'Baby & toddler', 'check'],
  ['Tissues', '10 boxes', 'Household', 'check'],
  ['Bin bags', '1 roll every 2–3 weeks', 'Household', 'check'],
  ['Disinfectant', '1', 'Household', 'check'],
  ['Washing-up liquid', '2', 'Household', 'check'],
  ['Anti-bac surface wipes and floor wipes', '1 pack every 2–3 weeks', 'Household', 'check'],
  ['Rubber gloves (medium)', '1 pair every couple of months', 'Household', 'check'],
  ['Clingfilm', 'As needed', 'Household', 'check'],
];

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS kitchen_shop_rules (
     id serial PRIMARY KEY,
     keyword text NOT NULL,
     not_keyword text,
     item_name text NOT NULL,
     aisle text NOT NULL,
     per_child numeric(10,2) NOT NULL,
     unit text NOT NULL DEFAULT 'g',
     pack_size numeric(10,2) NOT NULL,
     pack_label text,
     search_term text,
     is_active boolean NOT NULL DEFAULT true,
     sort_order integer NOT NULL DEFAULT 0,
     updated_by integer,
     updated_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (keyword, item_name))`,
  `CREATE TABLE IF NOT EXISTS kitchen_shop_week (
     week_start date NOT NULL,
     item_key text NOT NULL,
     have boolean NOT NULL DEFAULT false,
     in_basket boolean NOT NULL DEFAULT false,
     updated_by integer,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (week_start, item_key))`,
  `CREATE TABLE IF NOT EXISTS kitchen_shop_extras (
     id serial PRIMARY KEY,
     week_start date NOT NULL,
     name text NOT NULL,
     qty text,
     aisle text NOT NULL DEFAULT 'Food cupboard',
     added_by integer,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS kitchen_shop_choices (
     item_key text PRIMARY KEY,
     item_name text NOT NULL,
     product_url text,
     product_label text,
     search_term text,
     updated_by integer,
     updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS kitchen_training_progress (
     staff_id integer NOT NULL,
     course text NOT NULL,
     step_reached integer NOT NULL DEFAULT 0,
     checklist jsonb,
     completed_at timestamptz,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (staff_id, course))`,
];

let _ready = null;
function ensureSchema(db) {
  if (!_ready) {
    _ready = (async () => {
      for (const sql of SCHEMA_SQL) await db.query(sql);
      const { rows } = await db.query('SELECT count(*)::int AS n FROM kitchen_shop_rules');
      if (!rows[0].n) {
        for (let i = 0; i < RULES.length; i++) {
          const r = RULES[i];
          await db.query(
            `INSERT INTO kitchen_shop_rules (keyword, not_keyword, item_name, aisle, per_child, unit, pack_size, pack_label, search_term, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (keyword, item_name) DO NOTHING`,
            [r[0], r[1] || null, r[2], r[3], r[4], r[5], r[6], r[7], r[8], (i + 1) * 10]);
        }
      }
    })().catch(e => { _ready = null; throw e; });
  }
  return _ready;
}

function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Does this dish text call for this rule? Word-start match; not-phrases removed first. */
function ruleMatches(rule, dishText) {
  let t = ' ' + String(dishText || '').toLowerCase() + ' ';
  for (const n of String(rule.not_keyword || '').split('|').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    t = t.split(n).join(' ');
  }
  return String(rule.keyword || '').split('|').map(s => s.trim().toLowerCase()).filter(Boolean)
    .some(k => new RegExp('(^|[^a-z])' + esc(k)).test(t));
}

function fmtAmount(n, unit) {
  if (unit === 'each') return `${Math.ceil(n)}`;
  if (unit === 'ml') return n >= 1000 ? `${(n / 1000).toFixed(1)} litres` : `${Math.round(n)}ml`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}kg` : `${Math.round(n)}g`;
}

/** Which Monday does "this order" mean? Thu–Sun → next week (Friday order, Monday delivery). */
function defaultWeek(today) {
  const dow = K.dowOf(today);
  const mon = K.mondayStr(today);
  return (dow === 0 || dow >= 4) ? K.addDays(mon, 7) : mon;
}

async function defaultChildren(db) {
  const v = await K.getSetting(db, 'kitchen_shop_default_children', null);
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 200 ? n : 25;
}

/**
 * The whole list for one week. Counts only — never a child row.
 * @returns {{week_start, days:[{date,day,lunch,pudding,children,source}], aisles:[{aisle,items:[...]}], ...}}
 */
async function buildList(db, weekStart) {
  await ensureSchema(db);
  const [menu, rulesRes, weekRes, extrasRes, choicesRes, favRes, fallback] = await Promise.all([
    K.weekMenu(db, weekStart),
    db.query('SELECT * FROM kitchen_shop_rules WHERE is_active ORDER BY sort_order, id'),
    db.query('SELECT item_key, have, in_basket FROM kitchen_shop_week WHERE week_start = $1::date', [weekStart]),
    db.query('SELECT id, name, qty, aisle FROM kitchen_shop_extras WHERE week_start = $1::date ORDER BY id', [weekStart]),
    db.query('SELECT item_key, product_url, product_label, search_term FROM kitchen_shop_choices'),
    // b366 mappings Toby already pasted in against the old favourites list — reuse, don't re-ask.
    db.query(`SELECT lower(name) AS k, sainsburys_url, sainsburys_name FROM kitchen_shopping_favourites
               WHERE sainsburys_url IS NOT NULL`).catch(() => ({ rows: [] })),
    defaultChildren(db),
  ]);

  const days = [];
  for (const d of menu) {
    let count = 0, source = 'none';
    try {
      const p = await K.portionsToday(db, d.date);
      count = p.total; source = p.source;
    } catch (e) { /* fall back below */ }
    if (!count) { count = fallback; source = 'estimate'; }
    days.push({ date: d.date, day: d.day, lunch: d.lunch, pudding: d.pudding, children: count, source });
  }

  const state = new Map(weekRes.rows.map(r => [r.item_key, r]));
  const choices = new Map(choicesRes.rows.map(r => [r.item_key, r]));
  const favUrl = new Map(favRes.rows.map(r => [r.k, r]));

  const items = new Map();
  for (const rule of rulesRes.rows) {
    const used = days.filter(d => (d.lunch || d.pudding) && ruleMatches(rule, `${d.lunch || ''} ${d.pudding || ''}`));
    if (!used.length) continue;
    const key = 'r:' + slug(rule.item_name);
    const kids = used.reduce((s, d) => s + d.children, 0);
    const need = Number(rule.per_child) * kids * 1.1;
    const it = items.get(key) || {
      key, name: rule.item_name, aisle: rule.aisle, kind: 'menu', need: 0, unit: rule.unit,
      pack_size: Number(rule.pack_size), pack_label: rule.pack_label, search_term: rule.search_term || rule.item_name,
      for_days: new Set(), rule_ids: [],
    };
    it.need += need;
    used.forEach(d => it.for_days.add(d.day.split(' ')[0]));
    it.rule_ids.push(rule.id);
    items.set(key, it);
  }
  for (const it of items.values()) {
    const packs = Math.max(1, Math.ceil(it.need / it.pack_size));
    it.packs = packs;
    it.qty = `${packs} × ${it.pack_label || it.unit}`;
    it.why = `${fmtAmount(it.need, it.unit)} for ${[...it.for_days].join(', ')}`;
    it.for_days = [...it.for_days];
  }
  for (const s of STAPLES) {
    const key = 's:' + slug(s[0]);
    if (items.has(key)) continue;
    items.set(key, { key, name: s[0], aisle: s[2], kind: s[3] === 'check' ? 'check' : 'weekly', qty: s[1],
                     why: s[3] === 'check' ? 'Check the cupboard first' : 'Every week', search_term: s[0].replace(/\(.*?\)|"/g, '').trim() });
  }
  for (const x of extrasRes.rows) {
    items.set('x:' + x.id, { key: 'x:' + x.id, extra_id: x.id, name: x.name, aisle: AISLES.includes(x.aisle) ? x.aisle : 'Food cupboard',
                             kind: 'extra', qty: x.qty || '', why: 'You added this', search_term: x.name });
  }

  for (const it of items.values()) {
    const st = state.get(it.key);
    it.have = !!(st && st.have);
    it.in_basket = !!(st && st.in_basket);
    const ch = choices.get(it.key);
    const fav = favUrl.get(String(it.name).toLowerCase());
    it.usual_url = (ch && ch.product_url) || (fav && fav.sainsburys_url) || null;
    it.usual_label = (ch && ch.product_label) || (fav && fav.sainsburys_name) || null;
    if (ch && ch.search_term) it.search_term = ch.search_term;
    it.search_url = searchUrl(it.search_term);
  }

  const aisles = AISLES.map(a => ({
    aisle: a,
    items: [...items.values()].filter(i => i.aisle === a)
      .sort((x, y) => (x.kind === 'menu' ? 0 : 1) - (y.kind === 'menu' ? 0 : 1) || x.name.localeCompare(y.name)),
  })).filter(a => a.items.length);

  const all = [...items.values()];
  return {
    week_start: weekStart,
    week_label: `Week starting ${K.londonDayLabel(weekStart)}`,
    days,
    aisles,
    totals: {
      items: all.length,
      to_buy: all.filter(i => !i.have).length,
      in_basket: all.filter(i => !i.have && i.in_basket).length,
      have: all.filter(i => i.have).length,
    },
    no_menu: days.every(d => !d.lunch && !d.pudding),
  };
}

/** The list as plain text, for the "Copy list" button and a WhatsApp/email paste. */
function listText(list) {
  const lines = [`Sainsbury's list — ${list.week_label}`, ''];
  for (const a of list.aisles) {
    const buy = a.items.filter(i => !i.have);
    if (!buy.length) continue;
    lines.push(a.aisle.toUpperCase());
    for (const i of buy) lines.push(`[ ] ${i.name}${i.qty ? ' — ' + i.qty : ''}`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

async function setState(db, { week, key, field, value, user }) {
  await ensureSchema(db);
  if (!['have', 'in_basket'].includes(field)) throw K.httpError(400, 'unknown tick');
  if (!/^[rsx]:[a-z0-9-]{1,60}$/.test(String(key || ''))) throw K.httpError(400, 'bad item');
  await db.query(
    `INSERT INTO kitchen_shop_week (week_start, item_key, ${field}, updated_by, updated_at)
     VALUES ($1::date, $2, $3, $4, now())
     ON CONFLICT (week_start, item_key) DO UPDATE SET ${field} = EXCLUDED.${field}, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [week, key, !!value, (user && user.id) || null]);
  return { ok: true };
}

async function addExtra(db, { week, name, qty, aisle, user }) {
  await ensureSchema(db);
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!n) throw K.httpError(400, 'Type what you need first');
  const { rows: c } = await db.query('SELECT count(*)::int AS n FROM kitchen_shop_extras WHERE week_start = $1::date', [week]);
  if (c[0].n >= 60) throw K.httpError(400, 'That week already has 60 extra things');
  const { rows } = await db.query(
    `INSERT INTO kitchen_shop_extras (week_start, name, qty, aisle, added_by) VALUES ($1::date,$2,$3,$4,$5) RETURNING id`,
    [week, n, String(qty || '').trim().slice(0, 40) || null, AISLES.includes(aisle) ? aisle : 'Food cupboard', (user && user.id) || null]);
  return { id: rows[0].id };
}

async function removeExtra(db, { id }) {
  await ensureSchema(db);
  await db.query('DELETE FROM kitchen_shop_extras WHERE id = $1', [id]);
  return { ok: true };
}

/**
 * Remember "my usual" for an item. A pasted sainsburys.co.uk product link is
 * stored as the product; anything else typed is stored as the search words
 * (so next week's Search button looks for exactly that). Clearing forgets it.
 */
async function saveChoice(db, { key, name, text, user }) {
  await ensureSchema(db);
  if (!/^[rsx]:[a-z0-9-]{1,60}$/.test(String(key || ''))) throw K.httpError(400, 'bad item');
  const raw = String(text || '').trim();
  if (!raw) {
    await db.query('DELETE FROM kitchen_shop_choices WHERE item_key = $1', [key]);
    return { cleared: true };
  }
  let product_url = null, product_label = null, search_term = null;
  if (/sainsburys\.co\.uk/i.test(raw) || /^https?:\/\//i.test(raw)) {
    const p = SKU.parse(raw);
    if (!p.ok || !p.url) throw K.httpError(400, p.error || 'That is not a Sainsbury\'s product link.');
    product_url = p.url;
    product_label = p.name_guess || null;
  } else {
    search_term = raw.replace(/\s+/g, ' ').slice(0, 100);
    product_label = search_term;
  }
  await db.query(
    `INSERT INTO kitchen_shop_choices (item_key, item_name, product_url, product_label, search_term, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (item_key) DO UPDATE SET item_name = EXCLUDED.item_name, product_url = EXCLUDED.product_url,
       product_label = EXCLUDED.product_label, search_term = EXCLUDED.search_term,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, String(name || key).slice(0, 120), product_url, product_label, search_term, (user && user.id) || null]);
  return { product_url, product_label, search_term, search_url: search_term ? searchUrl(search_term) : null };
}

async function listRules(db) {
  await ensureSchema(db);
  const { rows } = await db.query('SELECT id, keyword, not_keyword, item_name, aisle, per_child, unit, pack_size, pack_label, search_term, is_active FROM kitchen_shop_rules ORDER BY sort_order, id');
  return rows;
}

async function updateRule(db, { id, body, user }) {
  await ensureSchema(db);
  const sets = [], vals = [];
  const put = (c, v) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
  const num = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw K.httpError(400, 'number out of range'); return n; };
  if (body.per_child !== undefined) put('per_child', num(body.per_child, 0, 5000));
  if (body.pack_size !== undefined) put('pack_size', num(body.pack_size, 0.01, 100000));
  if (body.pack_label !== undefined) put('pack_label', String(body.pack_label || '').slice(0, 40) || null);
  if (body.keyword !== undefined) { const k = String(body.keyword || '').trim().slice(0, 200); if (!k) throw K.httpError(400, 'keyword needed'); put('keyword', k); }
  if (body.search_term !== undefined) put('search_term', String(body.search_term || '').slice(0, 100) || null);
  if (typeof body.is_active === 'boolean') put('is_active', body.is_active);
  if (!sets.length) throw K.httpError(400, 'Nothing to change');
  put('updated_by', (user && user.id) || null);
  vals.push(id);
  const { rows } = await db.query(`UPDATE kitchen_shop_rules SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
  if (!rows.length) throw K.httpError(404, 'not found');
  return rows[0];
}

module.exports = {
  AISLES, RULES, STAPLES, SEARCH_BASE, searchUrl, ensureSchema, ruleMatches, defaultWeek,
  buildList, listText, setState, addExtra, removeExtra, saveChoice, listRules, updateRule,
};
