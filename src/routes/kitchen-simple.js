'use strict';
/**
 * src/routes/kitchen-simple.js — b331 (2026-09-15)
 *
 * The kitchen, made simple for the chef: the five big buttons on /ey/kitchen, and
 * the four-weekly Safer Food Better Business review for the manager in Roost.
 *
 * Mounted INSIDE src/routes/kitchen.js as router.use('/simple', …), after that
 * router's authenticate + kitchen-access gate, so every path here is
 * /api/kitchen/simple/* and is already limited to the cook/chef role or the
 * 'kitchen.access' capability (managers pass). The cook-role allow-list in
 * server-unified.js admits the 'kitchen' prefix, so no change was needed there.
 *
 * Everything the cook writes is for TODAY (London date) — there is no date
 * parameter on a cook write, so nothing can be back-filled from the tablet.
 *
 *   GET  /home                 the five buttons and their green/amber dots
 *   GET  /cooking              lunch + pudding, portions per room (counts), temp, served
 *   POST /cooking/served       sets menu_plans.served_at for today
 *   POST /cooking/temp         cooking/probe temperature of the main dish
 *   GET  /allergens            clash cards, texture cards, "I've read this" state
 *   POST /allergens/read       logged with who and when
 *   GET  /shopping             favourites, this week's orders, this week's menu
 *   POST /shopping             "Send to Toby" — a shopping_lists row + a board card
 *   PATCH /shopping/:id        manager: mark ordered / delivered
 *   GET  /checks               opening/closing questions (picked by the clock) + extras
 *   POST /checks/answer        one answer, saved as she goes
 *   POST /checks/note          a note on an answer ("what did you do?")
 *   POST /checks/log           delivery / hot-holding / cooling / probe calibration
 *   GET  /cleaning             only the tasks due today
 *   POST /cleaning/tick        tick / untick
 *   GET  /review?end=          manager: four-weekly SFBB review
 *   POST /review               manager: sign it off
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const K = require('../lib/kitchen-simple');
// b366 — string handling only; it makes no network request. See the file header
// for why the Sainsbury's mapping is typed in by a person and not fetched.
const SKU = require('../lib/sainsburys-sku');

router.use(express.json({ limit: '64kb' }));

router.use(async (req, res, next) => {
  try { await K.ensureSchema(getPool()); next(); }
  catch (e) {
    console.error('[kitchen-simple] schema:', e.message);
    res.status(500).json({ error: 'The kitchen tables are not ready.', detail: e.message });
  }
});

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const isManager = u => !!u && MANAGER_ROLES.includes(u.role);

function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    const status = e.status || 500;
    if (status >= 500) console.error('[kitchen-simple]', req.method, req.path, e.message);
    res.status(status).json({ error: e.message });
  });
}
const today = () => K.londonNow().date;

// ── home ────────────────────────────────────────────────────────────────────
router.get('/home', wrap(async (req, res) => {
  res.json(await K.homeState(getPool(), req.user));
}));

// ── today's cooking ─────────────────────────────────────────────────────────
router.get('/cooking', wrap(async (req, res) => {
  const db = getPool();
  const date = today();
  const [menu, portions, served, temp] = await Promise.all([
    K.todaysMenu(db, date), K.portionsToday(db, date), K.servedStatus(db, date), K.cookingTempToday(db, date),
  ]);
  res.json({
    date, day_label: K.londonDayLabel(date),
    menu: { lunch: menu.lunch, pudding: menu.pudding, allergens: menu.allergens, baby: menu.baby, weekend: menu.weekend },
    portions,                 // counts only
    baby_note: 'Baby Room: the same dishes, liquidised (blended smooth). Check the texture list on the Allergens screen.',
    served, cooking_temp: temp, cook_min: K.LIMITS.cook_min,
  });
}));

router.post('/cooking/served', wrap(async (req, res) => {
  res.status(201).json(await K.markServed(getPool(), { date: today(), user: req.user }));
}));

router.post('/cooking/temp', wrap(async (req, res) => {
  const db = getPool();
  const date = today();
  let food = req.body && req.body.food;
  if (!food) { const m = await K.todaysMenu(db, date); food = m.lunch || 'Lunch'; }
  res.status(201).json(await K.saveCookingTemp(db, { date, food, temp: req.body && req.body.temp_c, user: req.user }));
}));

// ── allergens ───────────────────────────────────────────────────────────────
router.get('/allergens', wrap(async (req, res) => {
  res.json(await K.allergenBoard(getPool(), today()));
}));

router.post('/allergens/read', wrap(async (req, res) => {
  const out = await K.markAllergensRead(getPool(), { date: today(), fingerprint: req.body && req.body.fingerprint, user: req.user });
  res.status(out.saved ? 201 : 409).json(out);
}));

// ── shopping ────────────────────────────────────────────────────────────────
router.get('/shopping', wrap(async (req, res) => {
  const db = getPool();
  const date = today();
  const [state, week] = await Promise.all([K.shoppingState(db, date), K.weekMenu(db, date)]);
  res.json(Object.assign({ date }, state, { week_menu: week }));
}));

router.post('/shopping', wrap(async (req, res) => {
  const db = getPool();
  const out = await K.sendShopping(db, { date: today(), items: req.body && req.body.items, note: req.body && req.body.note, user: req.user });
  // Put the card on Toby's board now rather than at the next 5-minute tick.
  let card = false;
  try {
    const r = await require('../services/attention').refresh({ only: ['kitchen'], quiet: true });
    card = !!(r.collectors[0] && r.collectors[0].ok);
  } catch (e) { console.error('[kitchen-simple] board refresh:', e.message); }
  res.status(201).json(Object.assign(out, { on_board: card, message: 'Sent to Toby.' }));
}));

router.patch('/shopping/:id', wrap(async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const id = parseInt(req.params.id, 10);
  const status = String((req.body && req.body.status) || '');
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  if (!['sent', 'ordered', 'delivered'].includes(status)) return res.status(400).json({ error: 'status must be sent, ordered or delivered' });
  const db = getPool();
  const { rows } = await db.query(`
    UPDATE shopping_lists SET status = $2::text,
           ordered_at   = CASE WHEN $2::text = 'ordered'   THEN now() ELSE ordered_at END,
           delivered_at = CASE WHEN $2::text = 'delivered' THEN now() ELSE delivered_at END
     WHERE id = $1 AND source = 'favourites' RETURNING id, status`, [id, status]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  try { await require('../services/attention').refresh({ only: ['kitchen'], quiet: true }); } catch { /* next tick */ }
  res.json(rows[0]);
}));

// ── b366: Sainsbury's SKUs ──────────────────────────────────────────────────
// The SKU lives on the FAVOURITE, not on ladn.ingredients. ingredients has
// carried sainsburys_sku since the first menu build and on prod 4 of its 87
// rows have one — but the chef's shopping screen sends favourites by name and
// never touches ingredients, so every SKU typed into that grid was attached to
// something nobody orders from. The SKU goes where the order is.
//
// Nothing in here makes a network request. See src/lib/sainsburys-sku.js for
// why: Sainsbury's publish no product API for a customer this size and their
// terms prohibit automated extraction, so the mapping is pasted in once by a
// person and then reused.

// GET /shopping/favourites — the mapping table (manager: it carries prices)
router.get('/shopping/favourites', wrap(async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const { rows } = await getPool().query(`
    SELECT id, name, unit, sort_order, is_active,
           sainsburys_sku, sainsburys_sku_kind, sainsburys_url, sainsburys_name,
           pack_size, sainsburys_last_price_pence, sainsburys_checked_at
      FROM kitchen_shopping_favourites ORDER BY sort_order, name`);
  const mapped = rows.filter(r => r.sainsburys_sku).length;
  res.json({
    favourites: rows.map(r => Object.assign({}, r, {
      product_url: SKU.productUrl(r.sainsburys_sku, r.sainsburys_sku_kind, r.sainsburys_url),
    })),
    mapped, total: rows.length, unmapped: rows.length - mapped,
    how: 'Open the product on sainsburys.co.uk, copy the address from the address bar, and paste it in. '
       + 'Wren reads the product out of the link — you do not need to find a product number.',
    why_by_hand: 'Sainsbury\'s do not publish a product API for a customer this size, and their terms '
       + 'do not allow Wren to read their site automatically. Each item is pasted in once and then reused.',
  });
}));

// PATCH /shopping/favourites/:id — paste a link, or type the details
router.patch('/shopping/favourites/:id', wrap(async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  const b = req.body || {};

  const sets = [], vals = [];
  const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

  // A pasted link wins: it is the only input that carries the SKU, the URL and
  // a usable product name all at once, and it is the only one a person can
  // produce without knowing anything about SKUs.
  if (b.link !== undefined) {
    const link = String(b.link || '').trim();
    if (!link) {                       // cleared on purpose — unmap it
      put('sainsburys_sku', null); put('sainsburys_sku_kind', null);
      put('sainsburys_url', null); put('sainsburys_name', null);
      put('sainsburys_last_price_pence', null);
    } else {
      const p = SKU.parse(link);
      if (!p.ok) return res.status(400).json({ error: p.error, parsed: p });
      put('sainsburys_sku', p.sku);
      put('sainsburys_sku_kind', p.kind);
      put('sainsburys_url', p.url);
      if (b.sainsburys_name === undefined && p.name_guess) put('sainsburys_name', p.name_guess);
    }
  } else if (b.sainsburys_sku !== undefined) {
    const p = SKU.parse(String(b.sainsburys_sku || ''));
    if (!p.ok && String(b.sainsburys_sku || '').trim()) return res.status(400).json({ error: p.error });
    put('sainsburys_sku', p.ok ? p.sku : null);
    put('sainsburys_sku_kind', p.ok ? p.kind : null);
  }

  if (b.sainsburys_name !== undefined) put('sainsburys_name', String(b.sainsburys_name || '').slice(0, 200) || null);
  if (b.pack_size !== undefined) put('pack_size', String(b.pack_size || '').slice(0, 60) || null);
  if (b.price_pence !== undefined) {
    const n = b.price_pence === null || b.price_pence === '' ? null : Math.round(Number(b.price_pence));
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100000)) {
      return res.status(400).json({ error: 'price must be in pence, 0 to 100000' });
    }
    put('sainsburys_last_price_pence', n);
  }
  if (typeof b.is_active === 'boolean') put('is_active', b.is_active);
  if (b.unit !== undefined) put('unit', String(b.unit || '').slice(0, 30) || null);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

  put('sainsburys_checked_at', new Date());
  put('sainsburys_checked_by', (req.user && req.user.id) || null);
  vals.push(id);
  const { rows } = await getPool().query(
    `UPDATE kitchen_shopping_favourites SET ${sets.join(', ')} WHERE id = $${vals.length}
     RETURNING id, name, unit, sainsburys_sku, sainsburys_sku_kind, sainsburys_url,
               sainsburys_name, pack_size, sainsburys_last_price_pence, sainsburys_checked_at`, vals);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(Object.assign({}, rows[0], {
    product_url: SKU.productUrl(rows[0].sainsburys_sku, rows[0].sainsburys_sku_kind, rows[0].sainsburys_url),
  }));
}));

// GET /shopping/:id/cart — a sent list, with the SKUs attached
//
// NOT an order. It places nothing and it can place nothing: it is the list a
// person fills a basket from, and the shape a browser extension would want if
// one is ever written. Items with no SKU are listed, not dropped — a cart file
// that quietly loses the four unmapped things is how a nursery runs out of milk.
router.get('/shopping/:id/cart', wrap(async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  const db = getPool();
  const { rows: ls } = await db.query(
    `SELECT id, week_start_date, status, items_json, ordered_by, note, created_at
       FROM shopping_lists WHERE id = $1`, [id]);
  if (!ls.length) return res.status(404).json({ error: 'not found' });
  const list = ls[0];

  const { rows: favs } = await db.query(`
    SELECT id, name, sainsburys_sku, sainsburys_sku_kind AS kind, sainsburys_url AS url,
           sainsburys_name, pack_size, sainsburys_last_price_pence AS price
      FROM kitchen_shopping_favourites`);
  const byFav = new Map(favs.map(f => [f.id, f]));

  const cart = SKU.buildCart(Array.isArray(list.items_json) ? list.items_json : [], byFav);
  res.json({
    shopping_list_id: list.id,
    week_start_date: list.week_start_date,
    sent_by: list.ordered_by, sent_at: list.created_at, status: list.status, note: list.note,
    supplier: 'Sainsbury\'s',
    ...cart,
    note_on_prices: cart.estimate_pence == null ? 'No prices are stored yet.'
      : `An estimate from the last price typed in, covering ${cart.estimate_covers} of ${cart.estimate_of} lines. Prices are not checked automatically.`,
  });
}));

// ── checks & temperatures ───────────────────────────────────────────────────
router.get('/checks', wrap(async (req, res) => {
  const db = getPool();
  const now = K.londonNow();
  const date = now.date;
  const limits = await K.getLimits(db);
  const [checks, sensors, logs, probe, temp, menu] = await Promise.all([
    K.checksStatus(db, date, limits), K.sensorStatus(db, limits), K.logsForDate(db, date),
    K.probeThisWeek(db, date), K.cookingTempToday(db, date), K.todaysMenu(db, date),
  ]);
  const strip = s => ({ done: s.done, answered: s.answered, total: s.total, label: s.label,
    completed_hhmm: s.completed_hhmm, completed_by: K.firstName(s.completed_by),
    answered_keys: Object.keys(s.answers).filter(k => s.answers[k].answered) });
  res.json({
    date, time: now.hhmm, shift: now.minutes < 12 * 60 ? 'opening' : 'closing',
    questions: { opening: K.publicChecks('opening'), closing: K.publicChecks('closing') },
    opening: strip(checks.opening), closing: strip(checks.closing),
    sensors: sensors.map(s => ({ location: s.location, label: s.label, status: s.status, flagged: s.flagged,
      title: s.title, reading: s.reading == null ? null : s.reading, at_hhmm: s.at_hhmm || null, limit: s.limit })),
    extras: {
      cooking_temp: temp,
      deliveries: logs.filter(l => l.kind === 'delivery').length,
      hot_holding: logs.filter(l => l.kind === 'hot_holding').length,
      cooling: logs.filter(l => l.kind === 'cooling').length,
      probe,
    },
    lunch: menu.lunch, limits,
  });
}));

router.post('/checks/answer', wrap(async (req, res) => {
  const b = req.body || {};
  res.status(201).json(await K.saveCheckAnswer(getPool(), {
    date: today(), shift: b.shift, key: b.key, answer: b.answer, note: b.note, user: req.user,
  }));
}));

router.post('/checks/note', wrap(async (req, res) => {
  const b = req.body || {};
  res.status(201).json(await K.noteCheckAnswer(getPool(), { date: today(), shift: b.shift, key: b.key, note: b.note, user: req.user }));
}));

router.post('/checks/log', wrap(async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  if (!['delivery', 'hot_holding', 'cooling', 'probe_calibration'].includes(kind)) return res.status(400).json({ error: 'unknown record' });
  res.status(201).json(await K.saveLog(getPool(), { date: today(), kind, body: b, user: req.user }));
}));

// ── cleaning ────────────────────────────────────────────────────────────────
router.get('/cleaning', wrap(async (req, res) => {
  res.json(await K.cleaningToday(getPool(), today()));
}));

router.post('/cleaning/tick', wrap(async (req, res) => {
  const b = req.body || {};
  const id = parseInt(b.task_id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'task_id required' });
  const db = getPool();
  const out = await K.tickCleaning(db, { date: today(), taskId: id, done: b.done !== false, user: req.user });
  res.status(201).json(Object.assign(out, await K.cleaningToday(db, today())));
}));

// ── four-weekly review (manager, Roost) ─────────────────────────────────────
router.get('/review', wrap(async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const end = K.validDate(req.query.end) ? req.query.end : today();
  res.json(await K.reviewPeriod(getPool(), end));
}));

router.post('/review', wrap(async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  const b = req.body || {};
  if (!K.validDate(b.period_start) || !K.validDate(b.period_end) || b.period_start > b.period_end) {
    return res.status(400).json({ error: 'period_start and period_end (YYYY-MM-DD) required' });
  }
  if (!String(b.problems_found || '').trim() && !String(b.actions_taken || '').trim() && !String(b.changes || '').trim()) {
    return res.status(400).json({ error: 'write at least one line before signing off' });
  }
  res.status(201).json(await K.saveReview(getPool(), { start: b.period_start, end: b.period_end, body: b, user: req.user }));
}));

module.exports = router;
