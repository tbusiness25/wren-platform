'use strict';
/* ===========================================================================
 * sainsburys-sku.js — b366 (2026-09-29)
 *
 * Turn what a person can actually get hold of — the address bar of a Sainsbury's
 * product page — into something Wren can store next to a shopping favourite.
 *
 * WHY THERE IS NO FETCH IN THIS FILE, AND WHY THERE WILL NOT BE
 * Sainsbury's publish no public product API. What exists is
 * `/groceries-api/gol-services/product/v1/product`, which is the website's own
 * internal endpoint: undocumented, unversioned for third parties, not offered
 * under any developer programme, and behind bot protection. Their Website Terms
 * prohibit automated extraction. Their trade APIs are for suppliers with a
 * commercial agreement and an EDI arrangement, which a nursery ordering four
 * pints of milk does not have. Their Groceries Click & Collect / delivery
 * accounts give a login, not an ordering API.
 *
 * So there are exactly three honest options and this file implements the third:
 *   1. Scrape the site. Against their terms; breaks; not doing it.
 *   2. Wait for an API. There isn't one coming for a customer this size.
 *   3. Let a person paste the product link ONCE per item and keep the mapping.
 *      26 favourites is an afternoon, and the list barely changes after that.
 *
 * Everything below is string handling. It makes no network request, which is
 * the property that makes it safe to run on a tablet in a kitchen.
 *
 * WHAT A "SKU" IS HERE
 * Sainsbury's identify a product two ways in a URL and both are useful:
 *   • a numeric product id (6–9 digits) — 'product_id'. This is the stable one.
 *   • a slug ('sainsburys-british-whole-milk-227l-4-pint') — 'slug'. It is what
 *     the modern gol-ui URL carries, it resolves, and it is human-readable, but
 *     it can change when packaging changes.
 * Both are stored; `kind` records which you have, so nobody later mistakes a
 * slug for a catalogue number.
 * =========================================================================== */

const HOST = /(^|\.)sainsburys\.co\.uk$/i;

/** A numeric product id, 6–9 digits, not a year and not a price. */
const NUMERIC = /^\d{6,9}$/;

/**
 * Parse a Sainsbury's product link.
 *
 * @param {string} input  a full URL, or a bare id/slug typed straight in.
 * @returns {{ok:boolean, sku:string|null, kind:string|null, url:string|null,
 *            name_guess:string|null, error:string|null}}
 */
function parse(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, sku: null, kind: null, url: null, name_guess: null, error: 'Nothing to read' };

  // Typed straight in: a bare product id, or a bare slug.
  if (!/^https?:\/\//i.test(raw) && !raw.includes('/')) {
    if (NUMERIC.test(raw)) return { ok: true, sku: raw, kind: 'product_id', url: null, name_guess: null, error: null };
    if (/^[a-z0-9][a-z0-9-]{4,}$/i.test(raw)) {
      return { ok: true, sku: raw.toLowerCase(), kind: 'slug', url: null, name_guess: prettify(raw), error: null };
    }
    return { ok: false, sku: null, kind: null, url: null, name_guess: null,
             error: 'That is not a product link, a product number or a product slug.' };
  }

  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return { ok: false, sku: null, kind: null, url: null, name_guess: null, error: 'That link will not parse.' }; }

  if (!HOST.test(u.hostname)) {
    return { ok: false, sku: null, kind: null, url: null, name_guess: null,
             error: `That link is for ${u.hostname}, not sainsburys.co.uk.` };
  }

  // The tidy URL, without the tracking that a copied link always carries.
  const clean = `https://${u.hostname.replace(/^m\./, 'www.')}${u.pathname.replace(/\/+$/, '')}`;

  // 1. The old shop URLs put the id in the query string — so for those the query
  //    IS the address, and stripping it to `clean` would store a link to nothing.
  for (const k of ['productId', 'productid', 'product_id', 'skuId', 'uid']) {
    const v = u.searchParams.get(k);
    if (v && NUMERIC.test(v)) {
      const keep = new URLSearchParams();
      for (const [qk, qv] of u.searchParams) {
        if (/^(utm_|gclid|fbclid|msclkid|_ga)/i.test(qk)) continue;   // a copied link is full of these
        keep.set(qk, qv);
      }
      return { ok: true, sku: v, kind: 'product_id',
               url: `${clean}${keep.toString() ? `?${keep}` : ''}`, name_guess: null, error: null };
    }
  }

  const parts = u.pathname.split('/').filter(Boolean);
  const idx = parts.findIndex(p => p.toLowerCase() === 'product');
  const tail = idx >= 0 ? parts.slice(idx + 1).filter(p => p.toLowerCase() !== 'details') : [];

  // 2. /product/details/<digits> or /product/<digits>
  const numeric = tail.find(p => NUMERIC.test(p));
  if (numeric) {
    return { ok: true, sku: numeric, kind: 'product_id', url: clean,
             name_guess: prettify(tail.find(p => !NUMERIC.test(p)) || ''), error: null };
  }

  // 3. The modern gol-ui slug.
  const slug = tail.find(p => /^[a-z0-9][a-z0-9-]{4,}$/i.test(p));
  if (slug) {
    return { ok: true, sku: slug.toLowerCase(), kind: 'slug', url: clean,
             name_guess: prettify(slug), error: null };
  }

  // A Sainsbury's link that is not a product page — a category, a search, the
  // basket. Saying so beats storing the homepage as a milk SKU.
  return { ok: false, sku: null, kind: null, url: clean, name_guess: null,
           error: 'That is a Sainsbury\'s link but not a product page — open the product itself and copy that address.' };
}

/** 'sainsburys-british-whole-milk-227l-4-pint' → 'Sainsburys British Whole Milk 227l 4 Pint' */
function prettify(slug) {
  const s = String(slug || '').replace(/[-_]+/g, ' ').trim();
  if (!s) return null;
  return s.replace(/\b[a-z]/g, c => c.toUpperCase()).slice(0, 160);
}

/** The product page for a stored mapping, or null if we only have a bare id. */
function productUrl(sku, kind, storedUrl) {
  if (storedUrl) return storedUrl;
  if (!sku) return null;
  if (kind === 'slug') return `https://www.sainsburys.co.uk/gol-ui/product/${sku}`;
  return null;   // a bare product id has no URL shape we can promise resolves
}

/**
 * Build the cart file for one sent shopping list.
 *
 * Deliberately NOT "an order". Nothing here places anything: it is a list with
 * the SKUs attached, which is what a person needs to fill a basket quickly and
 * what a browser extension would need if one is ever written. The count of
 * items WITHOUT a SKU is returned beside it rather than filtered away — a cart
 * file that silently drops the four things nobody has mapped is how a nursery
 * ends up with no milk.
 *
 * @param {Array} items    the shopping_lists.items_json rows ({name, qty, unit, favourite_id})
 * @param {Map}   skuByFav favourite_id → {sainsburys_sku, kind, url, name, pack_size, price}
 */
function buildCart(items, skuByFav) {
  const lines = [], unmapped = [];
  for (const it of (items || [])) {
    const fav = it && it.favourite_id != null ? skuByFav.get(Number(it.favourite_id)) : null;
    const byName = fav || [...skuByFav.values()].find(
      f => f.name && it && it.name && f.name.toLowerCase() === String(it.name).toLowerCase());
    if (byName && byName.sainsburys_sku) {
      lines.push({
        name: it.name,
        qty: it.qty || 1,
        unit: it.unit || byName.pack_size || null,
        sku: byName.sainsburys_sku,
        sku_kind: byName.kind || null,
        product_name: byName.sainsburys_name || null,
        pack_size: byName.pack_size || null,
        url: productUrl(byName.sainsburys_sku, byName.kind, byName.url),
        last_price_pence: byName.price == null ? null : Number(byName.price),
        line_estimate_pence: byName.price == null ? null : Number(byName.price) * (it.qty || 1),
      });
    } else {
      unmapped.push({ name: it && it.name, qty: it && it.qty, unit: it && it.unit });
    }
  }
  const estimable = lines.filter(l => l.line_estimate_pence != null);
  return {
    lines, unmapped,
    mapped_count: lines.length,
    unmapped_count: unmapped.length,
    // Only an estimate, and only of the part we have prices for. Saying
    // "£38.40" when a third of the list has no price is worse than saying
    // nothing, so the count of priced lines travels with the number.
    estimate_pence: estimable.length ? estimable.reduce((a, l) => a + l.line_estimate_pence, 0) : null,
    estimate_covers: estimable.length,
    estimate_of: lines.length + unmapped.length,
  };
}

module.exports = { parse, prettify, productUrl, buildCart, NUMERIC };
