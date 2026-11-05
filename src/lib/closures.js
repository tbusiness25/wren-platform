'use strict';
/**
 * closures.js — b194 (2026-08-19)
 *
 * ONE answer to "is the nursery open on this date?", shared by every occupancy, register
 * and ratio surface.
 *
 * WHY: ladn.bank_holidays has existed (83 rows, including 2026-08-31 "Summer bank holiday")
 * but was referenced in exactly one place — src/routes/rota.js, for staff leave. No
 * occupancy code consulted it, so Wren showed 10 children booked into the Baby Room on the
 * August bank holiday while the EyWorks register (correctly) greyed the day out. Every
 * headcount, every ratio requirement and every printed register was wrong for that day.
 *
 * A closed date means CLOSED: zero children, zero required staff. Two sources, same effect:
 *   • ladn.bank_holidays (division 'england-and-wales' — the statutory list)
 *   • ladn.settings key 'closure_dates' — a JSON array for everything else the nursery
 *     shuts for (INSET/training days, the Christmas shutdown, an emergency closure).
 *     Accepted shapes, mixed freely:
 *        "2026-12-24"
 *        { "date": "2026-12-24", "name": "Christmas Eve — closed" }
 *        { "from": "2026-12-24", "to": "2027-01-02", "name": "Christmas shutdown" }
 *
 * Read-only and defensive: any missing table, unreadable setting or malformed entry degrades
 * to "open", never to a thrown error — an occupancy page must not 500 because a JSON blob in
 * settings has a typo.
 */

const DIVISION = 'england-and-wales';
const TTL_MS = 60 * 1000;          // closures change ~never; a short cache is plenty
const _cache = new Map();          // schema-scoped key -> { at, map }

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDay = s => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/** Parse the settings 'closure_dates' blob into date -> label. Never throws. */
function parseClosureSetting(raw) {
  const out = new Map();
  if (!raw) return out;
  let arr;
  try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return out; }
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (isDate(item)) { out.set(item, 'Closure'); continue; }
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || item.label || 'Closure');
    if (isDate(item.date)) { out.set(item.date, name); continue; }
    if (isDate(item.from) && isDate(item.to) && item.from <= item.to) {
      // bounded so a typo'd year cannot spin here
      let d = item.from;
      for (let i = 0; i < 400 && d <= item.to; i++) { out.set(d, name); d = addDay(d); }
    }
  }
  return out;
}

/**
 * Closed dates in [from, to] as a Map of 'YYYY-MM-DD' -> label.
 * `db` is any pg pool/client. Cached per (search_path, range) for TTL_MS.
 */
async function loadClosures(db, from, to) {
  if (!isDate(from) || !isDate(to) || from > to) return new Map();
  let schema = 'ladn';
  try {
    const { rows } = await db.query('SELECT current_schema() AS s');
    if (rows[0] && rows[0].s) schema = rows[0].s;
  } catch (e) { /* keep the default */ }

  const key = `${schema}|${from}|${to}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;

  const map = new Map();
  try {
    const { rows } = await db.query(
      `SELECT holiday_date::text AS d, name FROM bank_holidays
        WHERE COALESCE(division, $3) = $3 AND holiday_date BETWEEN $1::date AND $2::date`,
      [from, to, DIVISION]);
    for (const r of rows) map.set(r.d, r.name || 'Bank holiday');
  } catch (e) { /* table absent in a demo/older schema — fall through */ }

  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'closure_dates'`);
    if (rows.length) {
      for (const [d, name] of parseClosureSetting(rows[0].value)) {
        if (d >= from && d <= to) map.set(d, name);   // an explicit closure wins the label
      }
    }
  } catch (e) { /* no settings row — fine */ }

  _cache.set(key, { at: Date.now(), map });
  return map;
}

/** Closures for the Mon–Fri week containing `weekStart` (which should already be a Monday). */
async function loadWeekClosures(db, weekStart) {
  const end = new Date(weekStart + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + 6);
  return loadClosures(db, weekStart, end.toISOString().slice(0, 10));
}

/** True when the setting is closed on `dateStr` (weekends included — we are Mon–Fri). */
function isClosedOn(map, dateStr) {
  if (!isDate(dateStr)) return false;
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return true;
  return !!(map && map.get && map.has(dateStr));
}

/** The reason a date is closed, or null. Weekends report null — they are simply not a session day. */
function closureLabel(map, dateStr) {
  return (map && map.get && map.get(dateStr)) || null;
}

function _clearCache() { _cache.clear(); }   // tests / long-running scripts

module.exports = { loadClosures, loadWeekClosures, isClosedOn, closureLabel, parseClosureSetting, DIVISION, _clearCache };
