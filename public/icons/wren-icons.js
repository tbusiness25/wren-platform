/* Wren Icons — original SVG line-icon pack (b146)
 * 24x24 viewBox, 1.75px stroke, round caps/joins, line style, currentColor.
 * A handful of "hero" icons carry a subtle 2-tone accent fill (brand blue/orange, ~15-18% opacity).
 * Usage:
 *   WrenIcons.get('home')                 -> raw <svg> markup string (or null if unknown)
 *   WrenIcons.keyFor('My Profile')        -> 'person' (label -> icon key lookup)
 *   WrenIcons.resolve(rawIconOrEmoji, label) -> svg markup if a mapped icon exists, else the raw
 *                                                string unchanged (automatic emoji fallback)
 *   WrenIcons.hydrate(root)               -> swap every [data-wren-icon] element's content for its
 *                                                SVG (leaves original text/emoji fallback in place
 *                                                if the key isn't registered)
 *   <wren-icon name="home" fallback="🏠"></wren-icon> -> custom element, same resolution + fallback
 */
(function () {
  'use strict';

  var BLUE = '#4a9abf';
  var ORANGE = '#e07820';

  // Wraps inner path/shape markup in the shared 24x24 stroke-icon shell.
  // opts.accent: hex colour for a soft 15-18% background wash (rounded-square) behind the strokes.
  function ic(inner, opts) {
    opts = opts || {};
    var bg = opts.accent
      ? '<rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="' + opts.accent + '" fill-opacity="0.16"/>'
      : '';
    return (
      '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
      'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      bg + inner + '</svg>'
    );
  }

  var ICONS = {
    // ── Core / navigation ────────────────────────────────────────────────
    home: ic('<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9"/>', { accent: BLUE }),
    cockpit: ic('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3.2 1.8"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>', { accent: BLUE }),
    more: ic('<circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/>'),

    // ── People / children ────────────────────────────────────────────────
    users: ic('<circle cx="9" cy="8" r="3"/><path d="M3.5 20c0-3.6 2.5-6.2 5.5-6.2s5.5 2.6 5.5 6.2"/><circle cx="17" cy="9.2" r="2.4"/><path d="M14.7 20c.3-2.7 1.9-4.7 4-5.3"/>', { accent: BLUE }),
    child: ic('<circle cx="12" cy="8" r="3.6"/><path d="M6.5 20c0-3.9 2.4-6.4 5.5-6.4s5.5 2.5 5.5 6.4"/>', { accent: ORANGE }),
    family: ic('<circle cx="7" cy="8" r="2.2"/><circle cx="17" cy="8" r="2.2"/><circle cx="12" cy="10.6" r="1.7"/><path d="M3 20c.3-3 1.8-5 4-5.4M21 20c-.3-3-1.8-5-4-5.4M8.2 20c.4-2.6 1.8-4 3.8-4s3.4 1.4 3.8 4"/>'),
    person: ic('<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-4 3-7 7-7s7 3 7 7"/>'),
    'user-plus': ic('<circle cx="9" cy="8.2" r="3.1"/><path d="M3.5 20c0-3.6 2.5-6.1 5.5-6.1s5.5 2.5 5.5 6.1"/><path d="M18 7.5v5M20.5 10h-5"/>'),
    handshake: ic('<path d="M2.5 12.5 6.5 9l3.7 3-1.6 1.5c-.6.6-.6 1.5 0 2.1.6.6 1.5.6 2.1 0L14.3 12l4.2 3.3"/><path d="M18.5 9 15 12l1.6 1.6"/><path d="M6.5 9 5 7.3M17.5 9 19 7.3"/>'),

    // ── Nursery / EY ──────────────────────────────────────────────────────
    sprout: ic('<path d="M12 21v-8.5"/><path d="M12 13c0-4-3-6.3-7-6.3.2 4.2 3.2 7.3 7 7.3"/><path d="M12 11.2c0-3.6 2.5-5.7 6-5.7 0 3.7-2.6 6.7-6 6.7"/>'),
    leaf: ic('<path d="M12 3c6 .8 8.3 5.8 6.3 11.8-5.3 2-10.3 0-11.3-6C6.3 6 8.3 4 12 3z"/><path d="M8 15 15 6"/>'),
    palm: ic('<path d="M12 21v-8"/><path d="M12 13c-1-4-4-6-8-5.5 1 3.6 4 6 8 5.5z"/><path d="M12 13c1-4 4-6 8-5.5-1 3.6-4 6-8 5.5z"/><path d="M12 13c-.6-3 .6-5.3 3-6.8"/>'),
    tree: ic('<circle cx="12" cy="8" r="5"/><path d="M12 13v8M9 21h6"/>'),
    'clipboard-check': ic('<rect x="5" y="4.5" width="14" height="17" rx="2"/><path d="M9 4.5V3.4A1.4 1.4 0 0 1 10.4 2h3.2A1.4 1.4 0 0 1 15 3.4v1.1"/><path d="M8.6 12.6l2.2 2.2 4.6-4.6"/>'),
    diary: ic('<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5z"/><path d="M9 8h7M9 12h7M9 16h4"/><path d="M5 4.5v15A1.5 1.5 0 0 0 6.5 21"/>'),
    story: ic('<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/><path d="M16.3 8.2l.5 1.1 1.2.2-.9.9.2 1.2-1-.6-1 .6.2-1.2-.9-.9 1.2-.2z"/>', { accent: ORANGE }),
    palette: ic('<path d="M12 3a9 8 0 1 0 0 16c1.4 0 2-1 1.3-2.1-.6-.9.1-2 1.2-2h1.6C18.6 14.9 20 13.4 20 11.5 20 6.8 16.4 3 12 3z"/><circle cx="8.3" cy="10" r="1.05" fill="currentColor" stroke="none"/><circle cx="11.5" cy="7.3" r="1.05" fill="currentColor" stroke="none"/><circle cx="15.2" cy="9" r="1.05" fill="currentColor" stroke="none"/>'),
    toolbox: ic('<rect x="3" y="9.5" width="18" height="10" rx="1.8"/><path d="M8.5 9.5V7A1.5 1.5 0 0 1 10 5.5h4A1.5 1.5 0 0 1 15.5 7v2.5"/><path d="M3 13.5h18M10.5 13.5v2.2M13.5 13.5v2.2"/>'),
    'flag-search': ic('<circle cx="10.2" cy="10.2" r="6.2"/><path d="M14.6 14.6 20.5 20.5"/><path d="M10.2 7.3v5.8"/>'),
    milestone: ic('<path d="M6 21V4"/><path d="M6 5h9l-2.2 3L15 11H6"/>'),
    target: ic('<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>', { accent: ORANGE }),
    'arrow-next': ic('<path d="M3.5 12h14"/><path d="M13 6.2l6 5.8-6 5.8"/>'),
    'layout-grid': ic('<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>'),
    book: ic('<path d="M4 5.7C4 4.8 4.7 4 5.6 4H12v16H5.6A1.6 1.6 0 0 1 4 18.4z"/><path d="M20 5.7c0-.9-.7-1.7-1.6-1.7H12v16h6.4a1.6 1.6 0 0 0 1.6-1.6z"/>'),
    feather: ic('<path d="M20 4c-6.2 0-13.2 3-15.2 10.3-.9 3.3.3 6 3.4 4.9C15.2 17 20 10 20 4z"/><path d="M7.6 16.4 20 4M10.8 13.2l-3 0M14 10l-3 0"/>', { accent: BLUE }),
    'first-aid': ic('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/>'),
    pill: ic('<rect x="3.5" y="9" width="17" height="6.4" rx="3.2" transform="rotate(-35 12 12)"/><path d="M9.5 6.7 14.5 17.3"/>'),
    moon: ic('<path d="M20 13.8A8.4 8.4 0 1 1 10.2 4a6.6 6.6 0 0 0 9.8 9.8z"/>'),

    // ── Comms / documents ────────────────────────────────────────────────
    message: ic('<path d="M4 5.5h16a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H9.3L5 21v-4H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"/>', { accent: BLUE }),
    feedback: ic('<path d="M4 5.5h16a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H10l-4.3 3.8V16H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"/><path d="M12 8.2l1 2 2.2.3-1.6 1.5.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.5 2.2-.3z"/>'),
    mail: ic('<rect x="3" y="5.3" width="18" height="13.4" rx="2"/><path d="M4 7l8 6 8-6"/>'),
    megaphone: ic('<path d="M3 10v4a1 1 0 0 0 1 1h2l1.5 5H10l-.7-5H11l8 3.5v-12L11 10H4a1 1 0 0 0-1 0z"/>'),
    bell: ic('<path d="M6 10.5a6 6 0 0 1 12 0c0 4.2 1.3 5.4 1.9 6.3H4.1c.6-.9 1.9-2.1 1.9-6.3z"/><path d="M10 19.5a2.1 2.1 0 0 0 4 0"/>'),
    document: ic('<path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M14 3.5V8h4"/><path d="M8.3 12.5h7.4M8.3 15.7h7.4M8.3 18.5h4.5"/>'),
    'document-chart': ic('<path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M14 3.5V8h4"/><path d="M8.5 18v-3.2M12 18v-5.4M15.5 18v-2.3"/>'),
    pencil: ic('<path d="M4 20l.9-3.9L16.4 4.6a1.6 1.6 0 0 1 2.3 0l.7.7a1.6 1.6 0 0 1 0 2.3L7.9 19.1z"/><path d="M14.7 6.9l2.4 2.4"/>'),

    // ── Health & safety ──────────────────────────────────────────────────
    shield: ic('<path d="M12 3.2l7 2.9v5.6c0 4.6-3 7.6-7 9.1-4-1.5-7-4.5-7-9.1V6.1z"/>', { accent: BLUE }),
    'shield-lock': ic('<path d="M12 3.2l7 2.9v5.3c0 4.9-3 8.1-7 9.6-4-1.5-7-4.7-7-9.6V6.1z"/><rect x="9.4" y="10.6" width="5.2" height="4.2" rx="1.1"/><path d="M10.4 10.6V9.2a1.6 1.6 0 0 1 3.2 0v1.4"/>'),
    'lock-open': ic('<rect x="4.5" y="10.3" width="15" height="10" rx="2"/><path d="M8 10.3V7.2a4 4 0 0 1 7.5-2"/>'),
    thermostat: ic('<path d="M12 3.5a2 2 0 0 0-2 2v9.1a3.5 3.5 0 1 0 4 0V5.5a2 2 0 0 0-2-2z"/><path d="M12 15.5V8"/>'),

    // ── Curriculum / learning ────────────────────────────────────────────
    'graduation-cap': ic('<path d="M2 9.2 12 5l10 4.2-10 4.2z"/><path d="M6.2 11.3v4.4c0 1.5 2.6 2.9 5.8 2.9s5.8-1.4 5.8-2.9v-4.4"/><path d="M21 9.2v6"/>', { accent: BLUE }),

    // ── Money ─────────────────────────────────────────────────────────────
    wallet: ic('<rect x="3" y="6.3" width="18" height="12.7" rx="2"/><path d="M3 10h18"/><circle cx="16.3" cy="14.3" r="1.1" fill="currentColor" stroke="none"/>', { accent: ORANGE }),
    receipt: ic('<path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5z"/><path d="M9 8h6M9 11.5h6M9 15h4"/>'),
    scale: ic('<path d="M12 3v18M6.5 7h11M6.5 7 3.5 13a3 3 0 0 0 6 0zM17.5 7l-3 6a3 3 0 0 0 6 0zM9 21h6"/>'),
    'piggy-bank': ic('<path d="M4.5 13.2a5.7 5.7 0 0 1 5.7-5.7h3.6a5.2 5.2 0 0 1 4.4 2.4l1.8-.6-.6 2.4a5.5 5.5 0 0 1-1.3 3v2.6h-2.4v-1.5h-6v1.5H7.3v-2.3a5.6 5.6 0 0 1-2.8-1.8z"/><circle cx="14.7" cy="12.3" r=".85" fill="currentColor" stroke="none"/><path d="M9 7.5V5.8M10.4 5.8h2.4"/>'),

    // ── Ops / admin ───────────────────────────────────────────────────────
    wrench: ic('<path d="M14.8 5.4a4 4 0 0 1-5.3 5.3L4.6 15.6a1.7 1.7 0 0 0 2.4 2.4l4.9-4.9a4 4 0 0 1 5.3-5.3l-2.5 2.5-1.8-1.8z"/>'),
    gear: ic('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.3M12 18.7V21M21 12h-2.3M5.3 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6"/>'),
    sliders: ic('<path d="M4 6h6M14 6h6M4 12h10M18 12h2M4 18h13M21 18h0"/><circle cx="12" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
    archive: ic('<rect x="3" y="4" width="18" height="6" rx="1.6"/><rect x="3" y="12" width="18" height="8" rx="1.6"/><path d="M10 16h4"/>'),
    box: ic('<path d="M3.5 8 12 4l8.5 4v8L12 20l-8.5-4z"/><path d="M3.5 8 12 12l8.5-4M12 12v8"/>'),
    kitchen: ic('<path d="M6 3v6a2.5 2.5 0 0 0 5 0V3M8.5 3v9M15.5 3c-1.4 1-2 2.5-2 4.2 0 1.6.9 2.5 2 2.8V21"/>'),
    'clock-in': ic('<circle cx="12" cy="13" r="7.4"/><path d="M12 9.7V13l2.3 1.3"/><path d="M12 2v3.2M9.2 3.6 12 5.2l2.8-1.6"/>'),
    clock: ic('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.5V12l3 2"/>'),
    calendar: ic('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
    'calendar-plus': ic('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M12 13.3v5.4M9.3 16h5.4"/>'),
    'grid-plus': ic('<rect x="3" y="3" width="8" height="8" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><path d="M17.2 13.3v7M13.7 16.8h7"/>'),

    // ── Intelligence / system ────────────────────────────────────────────
    broadcast: ic('<circle cx="12" cy="12" r="2"/><path d="M8.6 8.6a5 5 0 0 0 0 6.8M15.4 8.6a5 5 0 0 1 0 6.8M5.5 5.5a9.3 9.3 0 0 0 0 13M18.5 5.5a9.3 9.3 0 0 1 0 13"/>'),
    repeat: ic('<path d="M4 7h12l-3-3M20 17H8l3 3"/>'),
    bird: ic('<path d="M3 13.3c3.1-5 8.3-6.9 12.2-4.7-1-2.1-.8-3.4.3-4.4 2 1 3 2.9 2.9 5-.2 4.2-4.3 7.9-9.3 7.6-2 0-3.7-.7-5.6-.8 1-1 1.6-1.9 1.7-3.3-1.3.3-2 .6-2.2.6z"/><circle cx="15.6" cy="8.7" r=".7" fill="currentColor" stroke="none"/>', { accent: BLUE }),
    flask: ic('<path d="M10 3h4M9.2 3v6.2l-4.8 8.6a1.4 1.4 0 0 0 1.2 2.1h12.8a1.4 1.4 0 0 0 1.2-2.1l-4.8-8.6V3"/><path d="M7.3 15h9.4"/>'),
    'chart-up': ic('<path d="M4 17.5 9.5 12l3.7 3.7L20 8.2"/><path d="M14.7 8.2H20v5.3"/>', { accent: ORANGE }),
    binoculars: ic('<path d="M9 9.5V6.7a2 2 0 1 1 4 0M15 9.5V6.7"/><rect x="4" y="9.5" width="6" height="8" rx="2"/><rect x="14" y="9.5" width="6" height="8" rx="2"/><path d="M10 12.8h4"/>'),
    globe: ic('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.5 3.7 5.7 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.7-3.7-9S9.6 5.5 12 3z"/>'),
    unlock: ic('<rect x="4.5" y="10.3" width="15" height="10" rx="2"/><path d="M8 10.3V7.2a4 4 0 0 1 7.5-2"/>'),
    bug: ic('<rect x="8" y="8.5" width="8" height="9.5" rx="4"/><path d="M12 8.5V6M9.3 6.6 8 5M14.7 6.6 16 5M5.5 11.5l2.5 1M18.5 11.5l-2.5 1M5.5 17l2.7-1.2M18.5 17l-2.7-1.2M9.5 8.5a2.5 2 0 0 1 5 0"/>'),
    eye: ic('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
    mic: ic('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3.5M9 20.5h6"/>'),
    confetti: ic('<path d="M4 20l4.2-12.3L20 12z"/><path d="M13.5 3l1 2M18 5.3l1.8 1M15.7 8.3l1.9-1"/>', { accent: ORANGE }),
    heart: ic('<path d="M12 20.2c-4.6-3-8.5-6.2-8.5-10A4.7 4.7 0 0 1 12 7.1 4.7 4.7 0 0 1 20.5 10.2c0 3.8-3.9 7-8.5 10z"/>'),
    'book-heart': ic('<path d="M5 4.5h11.5A2.5 2.5 0 0 1 19 7v13H7.5A2.5 2.5 0 0 1 5 17.5z"/><path d="M5 17.5A2.5 2.5 0 0 1 7.5 15H19"/><path d="M12 13c-1.7-1.1-2.8-2-2.8-3.2a1.55 1.55 0 0 1 2.8-.95 1.55 1.55 0 0 1 2.8.95c0 1.2-1.1 2.1-2.8 3.2z"/>'),
    map: ic('<path d="M9 4.3 4 6.3v13.4l5-2 6 2 5-2V4.3l-5 2-6-2z"/><path d="M9 4.3v13.4M15 6.3v13.4"/>'),
    help: ic('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.5 2.5 0 1 1 3.6 2.3c-.9.5-1.3 1-1.3 2.1"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>'),
    logout: ic('<path d="M9 4H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h3"/><path d="M14 8l4 4-4 4M9 12h9"/>'),
    camera: ic('<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 4.8h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.4"/>'),
    mobile: ic('<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>'),
    desktop: ic('<rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M8 20h8M12 16v4"/>'),

    // ── b273 (2026-09-04) — the EY More menu asked for more icon variation.
    // Six of these keys were ALREADY written on /ey/more tiles (mirror, compass,
    // puzzle, checklist, bandage, door) but had never been registered here, so
    // every one of them silently fell back to its emoji. Three are new (sparkles,
    // wand, search). `bandage` ends up unused on that page after all — at 22px it
    // reads too much like `pill`, so Accidents & Incidents took `first-aid`
    // instead — but it is a fair icon and stays registered for the next caller.
    // Registry-only addition: nothing above this comment changed.
    mirror: ic('<ellipse cx="12" cy="9.6" rx="6" ry="7.1"/><path d="M9.4 16.2 8.4 21h7.2l-1-4.8"/><path d="M9.6 6.4a4.3 4.3 0 0 0-1.5 3.1"/>'),
    compass: ic('<circle cx="12" cy="12" r="8.4"/><path d="M15.2 8.8 13.4 13.4 8.8 15.2l1.8-4.6z"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>', { accent: BLUE }),
    puzzle: ic('<path d="M10.2 4h3.6v2a1.6 1.6 0 1 0 3.2 0V4H20v3.6h-2a1.6 1.6 0 1 0 0 3.2h2v9.2h-4.8v-2a1.6 1.6 0 1 0-3.2 0v2H4v-4.8h2a1.6 1.6 0 1 0 0-3.2H4V4z"/>', { accent: ORANGE }),
    checklist: ic('<rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="M7.8 8.4l1.4 1.4 2.4-2.4"/><path d="M7.8 14.2l1.4 1.4 2.4-2.4"/><path d="M14 8.6h3.2M14 14.4h3.2"/>'),
    bandage: ic('<rect x="1.8" y="8.4" width="20.4" height="7.2" rx="3.6" transform="rotate(-40 12 12)"/><path d="M8.4 8.4 15.6 15.6"/><circle cx="10.4" cy="12.6" r=".9" fill="currentColor" stroke="none"/><circle cx="13.6" cy="11.4" r=".9" fill="currentColor" stroke="none"/>'),
    door: ic('<path d="M6 21V4.6A1.6 1.6 0 0 1 7.6 3h8.8A1.6 1.6 0 0 1 18 4.6V21"/><path d="M4 21h16"/><circle cx="14.6" cy="12.4" r="1.1" fill="currentColor" stroke="none"/>', { accent: BLUE }),
    sparkles: ic('<path d="M11 3.4l1.5 3.9 3.9 1.5-3.9 1.5L11 14.2 9.5 10.3 5.6 8.8l3.9-1.5z"/><path d="M17.6 14.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>', { accent: ORANGE }),
    wand: ic('<path d="M4 20 15.4 8.6"/><path d="M14.2 4.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/><path d="M19.4 10.6l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>', { accent: ORANGE }),
    search: ic('<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.2 15.2 20.6 20.6"/>')
  };

  // Label (lowercased/trimmed) -> icon key. Multiple labels intentionally share a
  // concept (e.g. every "Absences" variant -> palm) — mirrors how the emoji set
  // already reused glyphs across related nav items.
  var LABEL_MAP = {
    'dashboard': 'home', 'admin dashboard': 'home', 'home': 'home',
    'cockpit': 'cockpit', 'more': 'more',
    'staff': 'users', 'team': 'users', 'all staff': 'users', 'group log': 'users',
    'children': 'child', 'children & families': 'child', 'child register': 'child', 'my child': 'child',
    'family': 'family',
    'my profile': 'person', 'profile': 'person', 'my account': 'person', 'my space': 'person', 'access': 'unlock',
    'supervisions': 'handshake', 'my supervisions': 'handshake', 'ealing ey partnership': 'handshake',
    'admissions': 'sprout', 'induction': 'sprout', 'my induction': 'sprout', 'new starters': 'sprout',
    'learning journey': 'leaf',
    'absences': 'palm', 'my absences': 'palm', 'absence approval': 'palm', 'report absence': 'palm',
    'framework': 'tree', 'framework tracker': 'tree', 'trackers': 'tree',
    'diary': 'diary', 'daily diary': 'diary',
    'story studio': 'story',
    'activity bank': 'palette', 'activities': 'palette',
    'teaching toolbox': 'toolbox',
    'sen early-flagging': 'flag-search',
    '2-year progress check': 'milestone',
    'action plans': 'target', 'my action plans': 'target', 'all my action plans': 'target',
    'next steps': 'arrow-next',
    'visual support': 'layout-grid',
    'curriculum': 'book', 'homework': 'book',
    // b276 gave Planning its own section and 2026-09-09 gave it its own sidebar
    // row. Without a key here keyFor() returns null and the row falls back to its
    // emoji — one emoji sitting in a column of line icons, which is exactly the
    // 'which version am I on' feeling. Termly/weekly planning is a calendar.
    'planning': 'calendar', 'termly planning': 'calendar', 'weekly planning': 'calendar',
    'termly plan': 'calendar', 'weekly plan': 'calendar',
    'fledge framework': 'feather', 'our curriculum: fledge': 'feather',
    'health & safety': 'first-aid', 'accident report': 'first-aid', 'accident': 'first-aid', 'incidents': 'first-aid',
    'medicine': 'pill', 'medicine consent': 'pill',
    'sleep check': 'moon', 'sleep checks': 'moon',
    'comms': 'message', 'communications': 'message', 'messages': 'message', 'message key person': 'message', 'parent messages': 'message',
    'parent app feedback': 'feedback', 'report a bug / feedback': 'bug',
    'send an email': 'mail', 'announcements': 'megaphone',
    'enable notifications': 'bell', 'notifications': 'bell',
    'policies': 'document', 'policies admin': 'document', 'policies to sign': 'document', 'my documents': 'document',
    'reports': 'document-chart', 'summative / transition reports': 'document-chart', 'report': 'document-chart',
    'drafts': 'pencil', 'drafts — also in sidebar ☰': 'pencil', 'quick observation': 'pencil', 'observation': 'pencil',
    'safeguarding': 'shield', 'log concern': 'shield',
    'inspection': 'clipboard-check', 'checklist': 'clipboard-check', 'review': 'clipboard-check', 'compliance': 'clipboard-check',
    'pastoral': 'heart',
    'operations': 'wrench', 'repairs': 'wrench', 'repairs & maintenance': 'wrench',
    'building controls (heating & fridges)': 'thermostat',
    'cpd': 'graduation-cap', 'my cpd': 'graduation-cap', 'learning & dev': 'graduation-cap',
    'pupils & teaching': 'graduation-cap', 'cpd matrix': 'graduation-cap', 'ai cpd creator': 'graduation-cap',
    'system': 'gear', 'personal': 'gear', 'settings': 'gear',
    'intelligence': 'broadcast', 'performance': 'chart-up',
    'automations': 'repeat', 'auto': 'repeat',
    'wren ai': 'bird', 'ask wren (ai assistant)': 'bird',
    'data governance': 'archive',
    'occupancy sandbox': 'flask',
    'occupancy planner': 'chart-up', 'mis dashboard': 'chart-up', 'obs tracker': 'chart-up',
    'competitor intel': 'binoculars',
    'access control': 'shield-lock', 'cf access': 'shield-lock',
    'sidebar layout': 'sliders',
    'website': 'globe', 'website builder': 'globe',
    'recruitment': 'user-plus',
    'how wren works': 'map',
    'fee schedule': 'receipt',
    'stretch reconciliation': 'scale', 'my leave weights': 'scale',
    'room headcounts': 'grid-plus', 'room headcount': 'grid-plus',
    'celebrations': 'confetti', 'staff celebrations': 'confetti',
    'toil': 'clock', 'my toil': 'clock', 'toil adjustments': 'clock',
    'staff clock-in': 'clock-in',
    'rota': 'calendar', 'my shifts': 'calendar', 'calendar': 'calendar',
    'add to your calendar': 'calendar-plus',
    'wellbeing': 'heart', 'my wellbeing': 'heart',
    'finance': 'wallet',
    'funding': 'piggy-bank',
    'gallery': 'camera', 'view gallery': 'camera',
    'kitchen': 'kitchen', 'menu': 'kitchen',
    'resources & equipment': 'box', 'resources': 'box',
    'record a voice note': 'mic',
    'show floating buttons on every page': 'eye',
    'request access / unblock': 'unlock',
    'help': 'help', 'help & training': 'help',
    'ai & intelligence': 'broadcast',
    'payroll': 'receipt',
    'sign out': 'logout',
    'mobile': 'mobile', 'desktop': 'desktop'
  };

  var WrenIcons = {
    ICONS: ICONS,
    LABEL_MAP: LABEL_MAP,
    get: function (key) { return ICONS[key] || null; },
    keyFor: function (label) {
      if (!label) return null;
      var k = String(label).replace(/\s+/g, ' ').trim().toLowerCase();
      return LABEL_MAP[k] || null;
    },
    resolve: function (rawIconOrEmoji, label) {
      var key = this.keyFor(label);
      if (key && ICONS[key]) return ICONS[key];
      return rawIconOrEmoji;
    },
    hydrate: function (root) {
      var scope = root || document;
      if (!scope.querySelectorAll) return;
      var els = scope.querySelectorAll('[data-wren-icon]');
      for (var i = 0; i < els.length; i++) {
        var key = els[i].getAttribute('data-wren-icon');
        var s = ICONS[key];
        if (s) els[i].innerHTML = s;
      }
    }
  };

  window.WrenIcons = WrenIcons;

  if (window.customElements && !customElements.get('wren-icon')) {
    customElements.define('wren-icon', class extends HTMLElement {
      static get observedAttributes() { return ['name']; }
      connectedCallback() { this._render(); }
      attributeChangedCallback() { this._render(); }
      _render() {
        var name = this.getAttribute('name');
        var svg = name && ICONS[name];
        if (svg) { this.innerHTML = svg; }
        else if (!this.textContent.trim()) { this.textContent = this.getAttribute('fallback') || ''; }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { WrenIcons.hydrate(); });
  } else {
    WrenIcons.hydrate();
  }
})();
