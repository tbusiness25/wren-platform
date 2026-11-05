'use strict';
/**
 * more-menu.js — b360 (2026-09-29).
 *
 * ONE source of truth for "what is on the EY More menu": the More page itself,
 * editions/ladn/public/ey/more.html, read and parsed here.
 *
 * ── WHY PARSE THE PAGE RATHER THAN KEEP A LIST ──────────────────────────────
 * Three things now need to know what is on that menu:
 *   1. the once-a-term question "which items will you never use?" (a checklist)
 *   2. per-person hiding — a nav_key posted to the API has to be a real tile
 *   3. the manager aggregate, which has to print a LABEL, not 'p-ey-sen-toolkit'
 *
 * A hard-coded copy of the list in this file would be wrong within a build:
 * CLAUDE.md's rule 3 is that nav items are only ever ADDED, and every build that
 * adds one would have to remember to add it here too. It would not — that is
 * precisely how the list would go stale and start hiding new pages from the
 * checklist. So the page stays the only place a tile is declared, and this file
 * reads it. b273 already guarantees the two things that makes possible: every
 * <li> carries a stable data-nav-key, and scripts/b273-verify.js asserts each
 * one equals _mpaKey(href).
 *
 * This is a READ. Nothing here writes to or rewrites more.html.
 *
 * ── THE PARSE ───────────────────────────────────────────────────────────────
 * Regex, not a DOM parser: the shape is machine-generated and stable (one <li>
 * per tile, one .ey-more-label inside it), there is no HTML parser in this
 * image's dependencies, and adding one for this would be a dependency to carry
 * forever. If the page's shape ever changes the parse returns fewer tiles, which
 * degrades to "fewer things you can hide" — never to a wrong answer about who
 * may see what, because this file is not a permission gate. The b237 capability
 * gate and each route's own auth are untouched by anything here.
 */

const fs = require('fs');
const path = require('path');

const MORE_HTML = path.join(__dirname, '..', '..', 'editions', 'ladn', 'public', 'ey', 'more.html');

// ── Tiles a person may never hide ────────────────────────────────────────────
// Mirrored into ladn.settings 'more_menu_never_hideable' by the b360 migration
// so the decision is readable from the database; scripts/b360-verify.js asserts
// the two agree. THIS list is the one enforced.
//
// Why each one:
//   • safeguarding / incidents / medicine (both the legacy record pages and the
//     "new ..." forms) — a practitioner who has switched off the route to
//     recording a concern has switched off a statutory duty, and the person who
//     most wants it gone is the person it most needs to stay for. Toby's brief
//     says managers cannot hide these; the rule here is that NOBODY can.
//   • settings — it is where hidden items are restored from. Hiding it would be
//     a one-way door.
//   • help, the bug button and this page — the ways to ask for help when the
//     menu you just edited is not what you wanted.
//   • sign out — shared tablets.
const NEVER_HIDEABLE = [
  'p-ey-legacy-safeguarding',
  'p-ey-legacy-incidents',
  'p-ey-legacy-medicine',
  'p-ey-safeguarding-new',
  'p-ey-incident-new',
  'p-ey-setting-incident-new',
  'p-ey-settings',
  'p-ey-help',
  'p-ey-staff-feedback',
  'g-report-a-bug-feedback',
  'g-sign-out',
];

let _cache = null;
let _cacheMtime = 0;

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '’').replace(/&nbsp;/g, ' ');
}

function attr(tag, name) {
  const m = new RegExp(name + '="([^"]*)"').exec(tag);
  return m ? m[1] : null;
}

function parse(html) {
  const groups = [];
  // Split on the section openers so every tile knows which group it is in.
  const sectionRe = /<section[^>]*class="[^"]*ey-more-section[^"]*"[^>]*>/g;
  const bounds = [];
  let m;
  while ((m = sectionRe.exec(html)) !== null) bounds.push({ tag: m[0], start: m.index + m[0].length });
  for (let i = 0; i < bounds.length; i++) {
    const end = i + 1 < bounds.length ? bounds[i + 1].start : html.length;
    const body = html.slice(bounds[i].start, end);
    const label = attr(bounds[i].tag, 'data-group');
    const groupKey = attr(bounds[i].tag, 'data-nav-key');
    const items = [];
    // One <li data-nav-key="..."> … </li> per tile.
    const liRe = /<li\s([^>]*data-nav-key="[^"]+"[^>]*)>([\s\S]*?)<\/li>/g;
    let li;
    while ((li = liRe.exec(body)) !== null) {
      const openTag = '<li ' + li[1] + '>';
      const inner = li[2];
      const key = attr(openTag, 'data-nav-key');
      if (!key) continue;
      const labelM = /class="ey-more-label"[^>]*>([\s\S]*?)</.exec(inner);
      const hrefM = /href="([^"]+)"/.exec(inner);
      items.push({
        key,
        label: labelM ? decodeEntities(labelM[1]).replace(/\s+/g, ' ').trim() : key,
        href: hrefM ? hrefM[1] : null,
        group: label ? decodeEntities(label) : 'More',
        capability: attr(openTag, 'data-capability'),
        role: attr(openTag, 'data-role'),
        hideable: NEVER_HIDEABLE.indexOf(key) === -1,
      });
    }
    // The b273 catch-all ships empty and hidden — it is not a group anyone picks
    // from, so it is only reported when a saved nav_layout has put something in it.
    if (items.length) {
      groups.push({ key: groupKey, label: label ? decodeEntities(label) : 'More', items });
    }
  }
  return groups;
}

// Groups (each with its items), cached until more.html changes on disk. The dev
// container bind-mounts editions/, so an edit to the page is picked up without a
// restart — the mtime check is what makes that true.
function groups() {
  let mtime = 0;
  try { mtime = fs.statSync(MORE_HTML).mtimeMs; } catch (_) { return _cache || []; }
  if (_cache && mtime === _cacheMtime) return _cache;
  try {
    _cache = parse(fs.readFileSync(MORE_HTML, 'utf8'));
    _cacheMtime = mtime;
  } catch (e) {
    console.error('[more-menu] could not read the More page:', e.message);
    _cache = _cache || [];
  }
  return _cache;
}

// Flat list of every tile.
function items() {
  return groups().reduce((all, g) => all.concat(g.items), []);
}

// key -> tile, for turning a stored nav_key back into words.
function byKey() {
  const map = {};
  items().forEach(i => { map[i.key] = i; });
  return map;
}

// Is this a real tile that this person is allowed to hide?
function isHideable(key) {
  const t = byKey()[key];
  return !!(t && t.hideable);
}

module.exports = { groups, items, byKey, isHideable, NEVER_HIDEABLE, MORE_HTML };
