'use strict';
/* Wren Phonics — book illustration kit (b248).
 * ---------------------------------------------------------------------------
 * Every page illustration in every Wren phonics book is COMPOSED from this file
 * plus src/content/phonics/illustration-tokens.json. Nothing is drawn by hand
 * per page and no hex code is ever written into a scene.
 *
 * Why it is built this way (the b248 brief's requirement, restated as code):
 *
 *   "Consistency is the whole deliverable."
 *
 * A character is therefore defined ONCE, as a set of parts in its own 200x200
 * box. A pose does not redraw anything — it only re-transforms limbs and swaps
 * the eyelid. So Pip in book 43 is byte-for-byte the same path data as Pip in
 * book 1, and check-illustrations.js proves it rather than trusting it.
 *
 * Parts tagged data-core are pose-INVARIANT (body, head, beak, eye, markings):
 * they must be identical across every pose of that character. Limbs and wings
 * move; cores never do.
 *
 * IP: all shapes below are original Wren line-art authored for this build. See
 * src/content/phonics/SPEC.md — nothing here derives from any commercial
 * phonics scheme's character designs.
 */

const fs = require('fs');
const path = require('path');

const TOKENS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../src/content/phonics/illustration-tokens.json'), 'utf8')
);

// ---- token accessors --------------------------------------------------------
// Colours are ONLY ever reached through c(); a bare hex anywhere in this file is
// a bug and check-illustrations.js fails the build on one.
function c(key) {
  const entry = TOKENS.palette[key];
  if (!entry) throw new Error(`illustration-kit: unknown palette token "${key}"`);
  return entry.hex;
}
const SW       = TOKENS.line.stroke_width;
const SW_D     = TOKENS.line.stroke_width_detail;
const SW_H     = TOKENS.line.stroke_width_hair;
const R        = TOKENS.radius;
const EYE      = TOKENS.eye;
const CHEEK    = TOKENS.cheek;
const CANVAS   = TOKENS.canvas;

// ---- primitives -------------------------------------------------------------
// Numbers are rounded to 2dp on the way out so the same shape always serialises
// to the same string (float drift would break the identity assertion).
const n = (v) => {
  const r = Math.round(Number(v) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};
const attrs = (o) => Object.keys(o)
  .filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '')
  .map((k) => `${k}="${typeof o[k] === 'number' ? n(o[k]) : o[k]}"`).join(' ');

function ellipse(cx, cy, rx, ry, o = {}) { return `<ellipse ${attrs({ cx, cy, rx, ry, ...o })}/>`; }
function circle(cx, cy, r, o = {})       { return `<circle ${attrs({ cx, cy, r, ...o })}/>`; }
function rrect(x, y, w, h, rad, o = {})  { return `<rect ${attrs({ x, y, width: w, height: h, rx: rad, ry: rad, ...o })}/>`; }
function pathEl(d, o = {})               { return `<path ${attrs({ d, ...o })}/>`; }
function group(inner, o = {})            { return `<g ${attrs(o)}>${inner}</g>`; }

// A filled shape: body colour + its own deep outline.
const solid = (fillKey, strokeKey, sw = SW) => ({ fill: c(fillKey), stroke: c(strokeKey), 'stroke-width': sw });
// An unfilled detail line in the deep tone.
const line  = (strokeKey, sw = SW_D) => ({ fill: 'none', stroke: c(strokeKey), 'stroke-width': sw });

// Vertical chord half-height of an ellipse at horizontal offset dx — lets stripes
// sit inside a body without needing a clipPath (clip ids would collide when two
// of the same character share a scene).
function chord(rx, ry, dx) {
  const t = 1 - (dx / rx) * (dx / rx);
  return t <= 0 ? 0 : ry * Math.sqrt(t);
}

// ---- the one eye ------------------------------------------------------------
// TOKENS.eye.style: solid dark disc + one white highlight offset up-left, plus
// an upper lid arc when the pose needs an expression. Identical in every book —
// at tablet arm's length this is the strongest recognition cue there is.
function eye(cx, cy, mode = 'open', scale = 1, lidKey = 'paper') {
  // 'wide' is a surprised eye — the same disc, opened larger. Without this it
  // would render identically to 'open' and the expression would be a no-op.
  const r = EYE.r * scale * (mode === 'wide' ? 1.18 : 1);
  const parts = [
    circle(cx, cy, r, { fill: EYE.ink, stroke: 'none' }),
    circle(cx + EYE.highlight_dx * scale, cy + EYE.highlight_dy * scale, EYE.highlight_r * scale, { fill: EYE.highlight, stroke: 'none' }),
  ];
  // The lid is drawn in the character's own body colour so it reads as an
  // eyelid closing over the eye. Drawn in ink it just makes the pupil bigger.
  // Filled only — never stroked. A lid stroked in its own fill colour is a
  // zero-contrast outline, and it gains nothing the fill does not already give.
  const lid = (dy, ry, extra) => pathEl(
    `M${n(cx - r * 1.25)} ${n(cy + dy)}a${n(r * 1.25)} ${n(ry)} 0 0 ${extra} ${n(r * 2.5)} 0z`,
    { fill: c(lidKey), stroke: 'none' });
  if (mode === 'happy')      parts.push(lid(-r * 0.34, r * 1.15, 0));
  else if (mode === 'sleepy') parts.push(lid(r * 0.30, r * 1.35, 0));
  // Added b389 (Printables PSED emotion cards) — a brow stroke above the
  // eye, drawn in ink, never touching the pupil. 'sad': outer corner droops
  // down. 'cross': inner corners pull down into a furrowed V. Not added to
  // EYE_MODES/the book canon below — these are for printables emotion faces
  // only, never used inside a phonics book scene.
  else if (mode === 'sad') parts.push(pathEl(`M${n(cx - r * 1.3)} ${n(cy - r * 1.6)}q${n(r * 1.3)} ${n(-r * 0.5)} ${n(r * 2.6)} ${n(r * 0.7)}`, line('ink', SW_D)));
  else if (mode === 'cross') parts.push(pathEl(`M${n(cx - r * 1.3)} ${n(cy - r * 1.9)}q${n(r * 1.3)} ${n(r * 0.9)} ${n(r * 2.6)} 0`, line('ink', SW_D)));
  return parts.join('');
}
function cheek(cx, cy, scale = 1) {
  return circle(cx, cy, CHEEK.r * scale, { fill: CHEEK.fill, opacity: CHEEK.opacity, stroke: 'none' });
}

// ---- pose rig ---------------------------------------------------------------
// Deliberately small. Six knobs cover every one of the 352 art briefs, and a
// small rig is what keeps 43 books looking like one scheme.
const DEFAULT_POSE = { tilt: 0, lift: 0, legs: 'stand', limb: 'rest', eye: 'open' };
const POSE_LIBRARY = {
  stand:  { tilt: 0,  lift: 0,  legs: 'stand',  limb: 'rest',  eye: 'open'  },
  sit:    { tilt: 0,  lift: 14, legs: 'tucked', limb: 'rest',  eye: 'open'  },
  happy:  { tilt: -3, lift: 0,  legs: 'stand',  limb: 'out',   eye: 'happy' },
  hop:    { tilt: -8, lift: 12, legs: 'hop',    limb: 'out',   eye: 'happy' },
  perch:  { tilt: -4, lift: 0,  legs: 'perch',  limb: 'rest',  eye: 'open'  },
  peck:   { tilt: 16, lift: 4,  legs: 'perch',  limb: 'rest',  eye: 'open'  },
  reach:  { tilt: -10, lift: 0, legs: 'stand',  limb: 'up',    eye: 'wide'  },
  fly:    { tilt: -6, lift: 70, legs: 'tucked', limb: 'up',    eye: 'open'  },
  hover:  { tilt: 0,  lift: 60, legs: 'tucked', limb: 'up',    eye: 'open'  },
  splash: { tilt: 6,  lift: 0,  legs: 'hop',    limb: 'out',   eye: 'happy' },
  curl:   { tilt: 0,  lift: 20, legs: 'tucked', limb: 'rest',  eye: 'sleepy' },
  sleep:  { tilt: 0,  lift: 18, legs: 'tucked', limb: 'rest',  eye: 'sleepy' },
  worry:  { tilt: 4,  lift: 0,  legs: 'stand',  limb: 'rest',  eye: 'wide'  },
  // Added b381 — limb/tilt/lift changes only, same six knobs as every pose above.
  pull:   { tilt: -14, lift: 8, legs: 'sit',    limb: 'out',   eye: 'wide'  },
  huff:   { tilt: 0,  lift: 0,  legs: 'stand',  limb: 'out',   eye: 'wide'  },
  listen: { tilt: -22, lift: 0, legs: 'stand',  limb: 'up',    eye: 'open'  },
  // Added b382 — leaning hard into a headwind, still standing.
  lean:   { tilt: -18, lift: 0, legs: 'stand',  limb: 'out',   eye: 'wide'  },
  // Added b383 — a comic sideways tumble (slipped and down flat), and a
  // joyful spin-in-place. Limb/tilt/lift only, same six knobs as every pose
  // above.
  sprawl: { tilt: 78,  lift: -10, legs: 'hop',  limb: 'out',   eye: 'wide'  },
  spin:   { tilt: -30, lift: 6,   legs: 'hop',  limb: 'out',   eye: 'happy' },
  // Added b384 — low stealth crawl (belly down, eyes up). Limb/tilt/lift
  // only; the "only eyes above the stems" effect is done with a front-layer
  // grass/bush prop placed over the character, not new rig geometry.
  crawl:  { tilt: 0,   lift: -8,  legs: 'tucked', limb: 'rest', eye: 'wide' },
};
function resolvePose(name) {
  return Object.assign({}, DEFAULT_POSE, POSE_LIBRARY[name] || POSE_LIBRARY.stand);
}
const POSE_NAMES = Object.keys(POSE_LIBRARY);

// A two-toe bird foot / stub leg, drawn from a hip point.
function birdLeg(x, hipY, footY, colKey, spread = 1) {
  const o = line(colKey, SW_D);
  return pathEl(`M${n(x)} ${n(hipY)}V${n(footY)}`, o) +
         pathEl(`M${n(x - 9 * spread)} ${n(footY)}h${n(18 * spread)}`, o) +
         pathEl(`M${n(x)} ${n(footY)}l${n(-5 * spread)} ${n(5)}M${n(x)} ${n(footY)}l${n(5 * spread)} ${n(5)}`, o);
}
function webFoot(x, hipY, footY, colKey, deepKey) {
  return pathEl(`M${n(x)} ${n(hipY)}V${n(footY - 4)}`, line(deepKey, SW_D)) +
         pathEl(`M${n(x - 14)} ${n(footY)}q${n(14)} ${n(-9)} ${n(28)} 0q${n(-14)} ${n(7)} ${n(-28)} 0z`,
           solid(colKey, deepKey, SW_H));
}

/* ---------------------------------------------------------------------------
 * THE CAST
 * ---------------------------------------------------------------------------
 * Six characters, matching src/content/phonics/characters.json exactly — same
 * ids, same species, same colour keys, so the book art and the existing
 * line-icon set are the same creatures.
 *
 * Local box: 200 x 200, feet on the ground line at y = 190, facing RIGHT.
 * The scene composer scales and mirrors; it never edits geometry.
 *
 * Each returns { core, limbs } — core is pose-invariant and is what the
 * identity check hashes.
 */
const CAST = {};

// --- Pip: upright egg body, pointed head tuft, short triangular beak ---------
CAST.pip_sparrow = {
  name: 'Pip', fill: 'sand', deep: 'sand_deep',
  brief: 'A small brown garden sparrow, endlessly curious, always the first to notice something.',
  core() {
    return [
      // tail wedge — part of the silhouette, so it counts as core
      pathEl('M56 128l-40 10 8 14 34 4z', solid('sand', 'sand_deep')),
      ellipse(100, 118, 52, 58, solid('sand', 'sand_deep')),
      ellipse(102, 140, 33, 34, { fill: c('white'), opacity: 0.55, stroke: 'none' }),
      // head tuft — three spikes, Pip's silhouette signature
      pathEl('M80 66l4-20 12 16 6-22 10 20 10-14 2 18z', solid('sand', 'sand_deep')),
      // beak
      pathEl('M146 106l32 13-32 13z', solid('sun', 'sun_deep', SW_D)),
      cheek(126, 126),
    ].join('');
  },
  limbs(p) {
    const wing = {
      rest: 'M74 104q30-12 44 12-16 26-44 14z',
      out:  'M74 100q34-24 54 4-22 30-54 14z',
      up:   'M76 100q26-44 56-24-14 34-54 26z',
    }[p.limb] || 'M74 104q30-12 44 12-16 26-44 14z';
    const legs = p.legs === 'tucked' ? ''
      : p.legs === 'hop' ? birdLeg(110, 172, 190, 'sand_deep')
      : p.legs === 'perch' ? birdLeg(92, 172, 186, 'sand_deep', 0.8) + birdLeg(112, 172, 186, 'sand_deep', 0.8)
      : birdLeg(88, 172, 190, 'sand_deep') + birdLeg(114, 172, 190, 'sand_deep');
    return legs + pathEl(wing, solid('sand', 'sand_deep', SW_D));
  },
  eyeAt: [128, 100], eyeScale: 1,
};

// --- Ned: low round body, flat wide bill, webbed feet -----------------------
CAST.ned_duckling = {
  name: 'Ned', fill: 'gold', deep: 'gold_deep',
  brief: 'A fluffy duckling, cheeky, never able to resist one more wobbly dare.',
  core() {
    return [
      pathEl('M48 108l-30-6 6 18 26 6z', solid('gold', 'gold_deep')),
      ellipse(96, 132, 58, 46, solid('gold', 'gold_deep')),
      ellipse(98, 146, 38, 28, { fill: c('white'), opacity: 0.5, stroke: 'none' }),
      circle(140, 80, 34, solid('gold', 'gold_deep')),
      // flat bill
      rrect(164, 74, 34, 19, R.sm, solid('brick', 'brick_deep', SW_D)),
      pathEl('M166 84h30', line('brick_deep', SW_H)),
      cheek(136, 96),
    ].join('');
  },
  limbs(p) {
    const wing = {
      rest: 'M78 118q28-8 38 14-14 22-40 10z',
      out:  'M76 114q34-20 50 6-20 26-50 12z',
      up:   'M78 114q22-38 50-20-12 30-48 24z',
    }[p.limb] || 'M78 118q28-8 38 14-14 22-40 10z';
    const legs = p.legs === 'tucked' ? ''
      : p.legs === 'hop' ? webFoot(106, 174, 190, 'brick', 'brick_deep')
      : webFoot(84, 174, 190, 'brick', 'brick_deep') + webFoot(112, 174, 190, 'brick', 'brick_deep');
    return legs + pathEl(wing, solid('gold', 'gold_deep', SW_D));
  },
  eyeAt: [150, 72], eyeScale: 0.95,
};

// --- Olive: wide barrel, two ear tufts, huge round eye discs ----------------
// Olive is the only one drawn facing the reader — two eye discs are her
// signature and make her unmistakable at 40px.
CAST.olive_owl = {
  name: 'Olive', fill: 'plum', deep: 'plum_deep',
  brief: 'A round grey-purple owl with very firm opinions and an eye on the whole garden.',
  core() {
    return [
      pathEl('M62 60l6-26 24 20zM138 60l-6-26-24 20z', solid('plum', 'plum_deep', SW_D)),
      pathEl('M100 54c40 0 62 34 62 78 0 34-26 56-62 56s-62-22-62-56c0-44 22-78 62-78z', solid('plum', 'plum_deep')),
      ellipse(100, 140, 40, 40, { fill: c('white'), opacity: 0.45, stroke: 'none' }),
      circle(78, 100, 26, solid('white', 'plum_deep', SW_D)),
      circle(122, 100, 26, solid('white', 'plum_deep', SW_D)),
      pathEl('M100 116l-11 16h22z', solid('sun', 'sun_deep', SW_H)),
      circle(84, 150, 5, { fill: c('plum_deep'), opacity: 0.5, stroke: 'none' }),
      circle(100, 162, 5, { fill: c('plum_deep'), opacity: 0.5, stroke: 'none' }),
      circle(116, 150, 5, { fill: c('plum_deep'), opacity: 0.5, stroke: 'none' }),
    ].join('');
  },
  limbs(p) {
    const wing = {
      rest: ['M42 106q-10 32 8 62 14-14 12-62z', 'M158 106q10 32-8 62-14-14-12-62z'],
      out:  ['M40 100q-26 24-18 58 24-8 30-56z', 'M160 100q26 24 18 58-24-8-30-56z'],
      up:   ['M42 100q-32-14-38 18 26 10 42-6z', 'M158 100q32-14 38 18-26 10-42-6z'],
    }[p.limb] || ['M42 106q-10 32 8 62 14-14 12-62z', 'M158 106q10 32-8 62-14-14-12-62z'];
    const legs = p.legs === 'tucked' ? ''
      : birdLeg(86, 186, 192, 'sun_deep', 0.9) + birdLeg(114, 186, 192, 'sun_deep', 0.9);
    return legs + wing.map((d) => pathEl(d, solid('plum', 'plum_deep', SW_D))).join('');
  },
  // Olive's two eyes are placed by her own override below.
  eyeAt: null, eyeScale: 1,
  eyes(mode) { return eye(78, 100, mode, 0.85, 'white') + eye(122, 100, mode, 0.85, 'white'); },
};

// --- Moss: low dome with a sawtooth spine ridge, long pointed snout ---------
CAST.moss_hedgehog = {
  name: 'Moss', fill: 'hedgehog', deep: 'hedgehog_deep',
  brief: 'A small hedgehog with a snuffly nose who curls up small around new friends.',
  core() {
    return [
      // sawtooth spine ridge — the silhouette signature, readable with all colour removed
      pathEl('M26 178q4-58 44-78l8 16 12-20 10 18 12-20 12 18 12-16q34 22 38 82z',
        solid('hedgehog', 'hedgehog_deep')),
      pathEl('M52 150l10-16M74 134l8-16M98 128l8-16M124 132l8-14', line('hedgehog_deep', SW_H)),
      // snout
      pathEl('M138 148q30 4 48 16-18 14-48 14z', solid('sand', 'sand_deep', SW_D)),
      circle(184, 164, 6, { fill: EYE.ink, stroke: 'none' }),
      cheek(146, 168, 0.8),
    ].join('');
  },
  limbs(p) {
    const legs = (p.legs === 'tucked' || p.legs === 'curl') ? ''
      : pathEl('M62 178v10M100 180v8M140 178v10', line('sand_deep', SW_D));
    const paw = p.limb === 'up' || p.limb === 'out'
      ? pathEl('M132 158q18-22 34-10-8 18-30 18z', solid('sand', 'sand_deep', SW_H)) : '';
    return legs + paw;
  },
  eyeAt: [146, 140], eyeScale: 0.8,
};

// --- Fig: horizontal run of five discs, two curled antennae -----------------
CAST.fig_caterpillar = {
  name: 'Fig', fill: 'leaf', deep: 'leaf_deep',
  brief: 'A stripy green caterpillar who double-checks everything twice.',
  core() {
    const seg = [40, 70, 100, 130].map((x) => circle(x, 152, 25, solid('leaf', 'leaf_deep'))).join('');
    const stripes = [40, 70, 100, 130].map((x) =>
      pathEl(`M${n(x - 13)} ${n(152 - chord(25, 25, 13))}V${n(152 + chord(25, 25, 13))}`, line('leaf_deep', SW_H))).join('');
    return [
      seg, stripes,
      circle(164, 148, 30, solid('leaf', 'leaf_deep')),
      cheek(158, 162, 0.8),
    ].join('');
  },
  limbs(p) {
    const ant = p.limb === 'up'
      ? 'M158 120q-4-26 12-30M176 120q6-24 22-22'
      : 'M158 120q-6-22 8-28M176 122q8-20 22-18';
    const feet = p.legs === 'tucked' ? ''
      : pathEl('M34 176v8M52 178v7M64 176v8M82 178v7M94 176v8M112 178v7M124 176v8', line('leaf_deep', SW_H));
    return feet + pathEl(ant, line('leaf_deep', SW_D)) +
      circle(170, 90, 5, solid('leaf', 'leaf_deep', SW_H)) +
      circle(198, 98, 5, solid('leaf', 'leaf_deep', SW_H));
  },
  eyeAt: [172, 140], eyeScale: 0.85,
};

// --- Nell: banded oval, two round wings, always hovering --------------------
CAST.nell_bee = {
  name: 'Nell', fill: 'sunflower', deep: 'sunflower_deep',
  brief: 'A fuzzy striped bumblebee, busy and kind, who needs reminding to slow down.',
  core() {
    // Bands are drawn as chords of the body ellipse — no clipPath, so two Nells
    // can share a scene without colliding ids.
    const band = (dx) => pathEl(
      `M${n(100 + dx)} ${n(120 - chord(46, 38, dx) + 2)}V${n(120 + chord(46, 38, dx) - 2)}`,
      { fill: 'none', stroke: c('sunflower_deep'), 'stroke-width': 11, 'stroke-linecap': 'round' });
    return [
      pathEl('M56 108l-26-14 4 22 24 8z', solid('sunflower', 'sunflower_deep', SW_D)),
      ellipse(100, 120, 46, 38, solid('sunflower', 'sunflower_deep')),
      band(-14), band(8), band(30),
      circle(142, 100, 26, solid('sunflower', 'sunflower_deep')),
      cheek(140, 116, 0.8),
    ].join('');
  },
  limbs(p) {
    const wingUp = p.limb === 'rest';
    const w = wingUp
      ? ['M98 88q-26-20-12-40 16-20 34 4 12 18-4 34z', 'M116 86q-6-32 16-38 24-6 20 20-4 22-26 26z']
      : ['M98 86q-34-10-30-34 4-26 32-10 18 12 12 40z', 'M116 84q-2-36 22-40 26-4 20 24-6 22-32 22z'];
    return w.map((d) => pathEl(d, { fill: c('white'), 'fill-opacity': 0.78, stroke: c('sunflower_deep'), 'stroke-width': SW_D })).join('') +
      pathEl('M84 152v14M100 156v14M116 152v14', line('sunflower_deep', SW_H)) +
      pathEl('M150 76q2-22 20-24M164 78q10-18 26-14', line('sunflower_deep', SW_H)) +
      circle(172, 50, 5, solid('sunflower', 'sunflower_deep', SW_H)) +
      circle(192, 62, 5, solid('sunflower', 'sunflower_deep', SW_H));
  },
  eyeAt: [152, 94], eyeScale: 0.85,
  // Nell hovers: she never stands on the ground line, in any pose.
  alwaysAirborne: 42,
};

const CAST_IDS = Object.keys(CAST);

/* ---------------------------------------------------------------------------
 * Render one character.
 * Pure: identical (id, pose, eyeMode) always yields identical markup, which is
 * exactly what check-illustrations.js asserts across all 43 books.
 */
function renderCharacter(id, poseName = 'stand', eyeOverride = null) {
  const ch = CAST[id];
  if (!ch) throw new Error(`illustration-kit: unknown character "${id}"`);
  const p = resolvePose(poseName);
  const eyeMode = eyeOverride || p.eye;

  const core = ch.core();
  const eyes = ch.eyes ? ch.eyes(eyeMode)
    : (ch.eyeAt ? eye(ch.eyeAt[0], ch.eyeAt[1], eyeMode, ch.eyeScale || 1, ch.fill) : '');
  const limbs = ch.limbs(p);

  // Cores and eyes are pose-invariant and carry data-core so the checker can
  // isolate them; limbs are the only thing a pose is allowed to change.
  // Three layers, deliberately: limbs move with the pose, the core NEVER does,
  // and the face carries the expression. Keeping the face out of the core is
  // what makes "identical across books" a testable claim rather than a slogan.
  const inner =
    group(limbs, { class: 'wi-limb', 'data-limb': '1' }) +
    group(core, { class: 'wi-core', 'data-core': '1' }) +
    group(eyes, { class: 'wi-face', 'data-face': '1' });

  const lift = (p.lift || 0) + (ch.alwaysAirborne || 0);
  const t = [];
  if (lift) t.push(`translate(0 ${n(-lift)})`);
  if (p.tilt) t.push(`rotate(${n(p.tilt)} 100 190)`);

  return group(inner, {
    class: `wi-ch wi-${id}`,
    'data-ch': id,
    'data-pose': poseName,
    'data-eye': eyeMode,
    transform: t.length ? t.join(' ') : undefined,
  });
}

// The pose-invariant markup of a character, for the identity assertion.
function characterCore(id) { return CAST[id].core(); }

/* ---------------------------------------------------------------------------
 * PROPS — the world the cast lives in. Each is a function of (o) returning
 * markup drawn around its own origin, scaled/placed by the composer.
 */
const PROPS = {
  sun: () => circle(0, 0, 38, solid('sun', 'sun_deep')) +
    pathEl('M0 -54v-14M0 54v14M-54 0h-14M54 0h14M-38 -38l-10-10M38 38l10 10M38 -38l10-10M-38 38l-10 10', line('sun_deep', SW)),

  cloud: () => pathEl('M-56 18q-20 0-20-18t20-18q2-24 26-24 12 0 20 10 10-16 30-16 26 0 28 26 18 2 18 20t-20 20z',
    solid('white', 'white_deep', SW_D)),

  moon: () => pathEl('M14 -40a44 44 0 1 0 0 80 36 36 0 0 1 0-80z', solid('white', 'white_deep', SW_D)),

  star: () => pathEl('M0 -14l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z', solid('sun', 'sun_deep', SW_H)),

  // Brick wall — a low run, courses offset. Used as a sitting place all through.
  brick_wall: (o) => {
    const w = o.w || 240, h = o.h || 70, rows = Math.max(1, Math.round(h / 24));
    let m = rrect(-w / 2, -h, w, h, R.sm, solid('brick', 'brick_deep', SW_D));
    for (let r = 1; r < rows; r++) {
      const y = -h + (h / rows) * r;
      m += pathEl(`M${n(-w / 2)} ${n(y)}h${n(w)}`, line('brick_deep', SW_H));
    }
    for (let r = 0; r < rows; r++) {
      const y0 = -h + (h / rows) * r, y1 = y0 + h / rows;
      const off = r % 2 ? 0 : (w / 8);
      for (let x = -w / 2 + off; x < w / 2 - 4; x += w / 4) {
        if (x <= -w / 2 + 2) continue;
        m += pathEl(`M${n(x)} ${n(y0)}V${n(y1)}`, line('brick_deep', SW_H));
      }
    }
    return m;
  },

  // The brass garden tap book 1 is built around. Origin sits on the mounting
  // face; the spout tip is at (38,-46) so a drip lines up under it exactly.
  tap: () => rrect(-16, -12, 32, 14, R.sm, solid('metal', 'metal_deep', SW_D)) +
    rrect(-9, -84, 18, 74, R.sm, solid('metal', 'metal_deep', SW_D)) +
    pathEl('M8 -76q30 0 30 20v12', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': 17, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) +
    pathEl('M8 -76q30 0 30 20v12', { fill: 'none', stroke: c('metal'), 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) +
    rrect(-18, -98, 36, 18, R.sm, solid('metal', 'metal_deep', SW_D)) +
    pathEl('M0 -98v-9', line('metal_deep', SW_D)) +
    circle(0, -114, 11, solid('metal', 'metal_deep', SW_D)) +
    pathEl('M-7 -114h14M0 -121v14', line('metal_deep', SW_H)),

  drip: () => pathEl('M0 -14q11 12 11 20a11 11 0 0 1-22 0q0-8 11-20z', solid('water', 'water_deep', SW_H)),

  // A puddle: flat pool with a light sheen.
  puddle: (o) => ellipse(0, 0, (o.w || 130) / 2, (o.h || 26) / 2, solid('water', 'water_deep', SW_D)) +
    ellipse(-(o.w || 130) / 8, -(o.h || 26) / 6, (o.w || 130) / 6, (o.h || 26) / 8, { fill: c('white'), opacity: 0.45, stroke: 'none' }),

  // Expanding rings — the b248 way of drawing "sound" without printing letters,
  // which matters in a phonics book where stray glyphs would be read as words.
  ripples: (o) => {
    const rings = o.rings || 3;
    let m = '';
    for (let i = 1; i <= rings; i++) {
      m += ellipse(0, 0, 16 * i, 6 * i, { fill: 'none', stroke: c('water_deep'), 'stroke-width': SW_H, opacity: n(0.85 - i * 0.16) });
    }
    return m;
  },

  // A crown of water with three flung droplets — reads as a splash at 40px,
  // which the earlier fan-of-lines version did not.
  splash: () => pathEl('M-34 2q6-24 16-30 4 16 12 20 4-18 14-24 2 18 10 22 6-14 16-16', solid('water', 'water_deep', SW_D)) +
    ellipse(-26, -44, 6, 8, solid('water', 'water_deep', SW_H)) +
    ellipse(2, -56, 7, 9, solid('water', 'water_deep', SW_H)) +
    ellipse(28, -40, 5, 7, solid('water', 'water_deep', SW_H)),

  // o.key (default 'water') picks the tint — pass 'earth' for a dry muddy
  // print rather than a wet one (31-toes-in-the-mud: "Ned's great muddy
  // prints", as distinct from a puddle-side wet print).
  footprint: (o) => {
    const key = `${o.key || 'water'}_deep`;
    return ellipse(0, 0, 8, 5, { fill: c(key), opacity: 0.42, stroke: 'none' }) +
      circle(-6, -7, 2.6, { fill: c(key), opacity: 0.42, stroke: 'none' }) +
      circle(0, -9, 2.6, { fill: c(key), opacity: 0.42, stroke: 'none' }) +
      circle(6, -7, 2.6, { fill: c(key), opacity: 0.42, stroke: 'none' });
  },

  grass_tuft: () => pathEl('M0 0q-4-22-14-30M0 0q0-26 2-34M0 0q6-20 16-28', line('grass_deep', SW_D)),

  pebble: (o) => ellipse(0, 0, o.w ? o.w / 2 : 13, o.h ? o.h / 2 : 8, solid('earth', 'earth_deep', SW_H)),

  oak_tree: () => rrect(-16, -110, 32, 112, R.sm, solid('wood', 'wood_deep', SW_D)) +
    circle(-44, -140, 44, solid('leafy', 'leafy_deep')) +
    circle(40, -134, 40, solid('leafy', 'leafy_deep')) +
    circle(0, -172, 50, solid('leafy', 'leafy_deep')),

  bush: (o) => circle(-(o.w || 90) / 4, -12, (o.w || 90) / 4, solid('leafy', 'leafy_deep', SW_D)) +
    circle((o.w || 90) / 4, -16, (o.w || 90) / 4.4, solid('leafy', 'leafy_deep', SW_D)) +
    circle(0, -30, (o.w || 90) / 3.4, solid('leafy', 'leafy_deep', SW_D)),

  flower: () => pathEl('M0 0V-34', line('grass_deep', SW_D)) +
    [0, 72, 144, 216, 288].map((a) => {
      const rad = (a - 90) * Math.PI / 180;
      return ellipse(Math.cos(rad) * 13, -34 + Math.sin(rad) * 13, 10, 10, solid('petal', 'petal_deep', SW_H));
    }).join('') + circle(0, -34, 7, solid('sun', 'sun_deep', SW_H)),

  fence: (o) => {
    const w = o.w || 200; let m = '';
    for (let x = -w / 2; x <= w / 2; x += 34) m += rrect(x - 6, -56, 12, 58, R.sm, solid('wood', 'wood_deep', SW_H));
    m += rrect(-w / 2 - 6, -44, w + 12, 9, R.sm, solid('wood', 'wood_deep', SW_H));
    m += rrect(-w / 2 - 6, -22, w + 12, 9, R.sm, solid('wood', 'wood_deep', SW_H));
    return m;
  },

  nest: () => pathEl('M-46 6q0-30 46-30t46 30q-10 12-46 12t-46-12z', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M-36 -6q22-8 72 0M-30 4q26-6 60 0', line('wood_deep', SW_H)),

  reeds: () => pathEl('M-18 0V-52M0 0V-64M18 0V-46', line('grass_deep', SW)) +
    ellipse(-18, -58, 5, 12, solid('wood', 'wood_deep', SW_H)) +
    ellipse(0, -70, 5, 13, solid('wood', 'wood_deep', SW_H)),

  /* -------------------------------------------------------------------------
   * Added b381 — the shared prop/creature library survey (PROPS.md) found
   * these needed across books 2-43. Drawn once here, every later batch reuses
   * them rather than re-inventing its own. See src/content/phonics/PROPS.md.
   * ---------------------------------------------------------------------- */

  // A dented biscuit tin — lying on its side (open end toward viewer, the
  // default) or standing upright as an impromptu drum. o.pose: 'side' | 'up'.
  tin: (o) => {
    if (o.pose === 'up') {
      const w = o.w || 86, h = o.h || 70;
      return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('metal', 'metal_deep', SW_D)) +
        ellipse(0, -h, w / 2, 10, solid('metal', 'metal_deep', SW_H)) +
        pathEl(`M${n(-w / 2 + 8)} ${n(-h * 0.66)}h${n(w - 16)}M${n(-w / 2 + 8)} ${n(-h * 0.33)}h${n(w - 16)}`, line('metal_deep', SW_H));
    }
    // Lying on its side: ridge lines read it as a cylinder, and the open end
    // is a FILLED dark ellipse (not a hairline outline) so it reads as a
    // hollow tin, not a pebble. Fixed b382 — batch 1 review.
    const w = o.w || 110, h = o.h || 58;
    return ellipse(0, n(-h / 2), w / 2, h / 2, solid('metal', 'metal_deep', SW_D)) +
      [0.28, 0.5, 0.72].map((f) => pathEl(`M${n(-w / 2 + w * f)} ${n(-h * 0.9)}L${n(-w / 2 + w * f)} ${n(-h * 0.1)}`, line('metal_deep', SW_H))).join('') +
      ellipse(n(w * 0.32), n(-h * 0.5), n(h * 0.4), n(h * 0.3), { fill: c('metal_deep'), stroke: 'none' }) +
      pathEl(`M${n(-w / 2 + 10)} ${n(-h * 0.86)}q${n(w / 2 - 10)} -10 ${n(w - 20)} 0`, line('metal_deep', SW_H));
  },

  // A small garden shed — gable roof, plank door, one window. Origin on the
  // ground at its centre-front.
  shed: (o) => {
    const w = o.w || 150, h = o.h || 120, roof = h * 0.3;
    return rrect(n(-w / 2), n(-h + roof), w, n(h - roof), R.sm, solid('wood', 'wood_deep', SW_D)) +
      pathEl(`M${n(-w / 2 - 8)} ${n(-h + roof)}L0 ${n(-h - 6)}L${n(w / 2 + 8)} ${n(-h + roof)}z`, solid('brick', 'brick_deep', SW_D)) +
      rrect(n(-w * 0.12), n(-h * 0.55), n(w * 0.24), n(h * 0.55), R.sm, solid('earth', 'earth_deep', SW_H)) +
      pathEl(`M${n(-w * 0.12)} ${n(-h * 0.28)}h${n(w * 0.24)}`, line('earth_deep', SW_H)) +
      rrect(n(w * 0.2), n(-h * 0.72), n(w * 0.16), n(h * 0.16), R.sm, solid('sky', 'wood_deep', SW_H)) +
      pathEl(`M${n(w * 0.2 + w * 0.08)} ${n(-h * 0.72)}v${n(h * 0.16)}M${n(w * 0.2)} ${n(-h * 0.64)}h${n(w * 0.16)}`, line('wood_deep', SW_H));
  },

  // A stripy doormat, obviously too small for whoever is sitting on it.
  doormat: (o) => {
    const w = o.w || 80, h = o.h || 34;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('earth', 'earth_deep', SW_D)) +
      [0.3, 0.55, 0.8].map((f) => pathEl(`M${n(-w / 2 + 6)} ${n(-h * f)}h${n(w - 12)}`, line('earth_deep', SW_H))).join('');
  },

  // A dug hole with a mound of turned earth at the rim — the shared ground
  // feature for every digging book.
  hole: (o) => {
    const w = o.w || 120, h = o.h || 46;
    return ellipse(0, 6, n(w / 2 + 14), n(h / 2 + 6), solid('earth', 'earth_deep', SW_D)) +
      ellipse(0, 2, n(w / 2), n(h / 2), { fill: c('earth_deep'), opacity: 0.6, stroke: 'none' });
  },

  // A single low step at an unseen door's threshold.
  doorstep: (o) => {
    const w = o.w || 90, h = o.h || 20;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('earth', 'earth_deep', SW_D));
  },

  // A fat mossy log lying on the ground — sitting place, hiding place, picnic
  // table. o.w controls its length.
  log: (o) => {
    const w = o.w || 170, h = o.h || 50;
    return rrect(n(-w / 2), -h, w, h, R.md, solid('wood', 'wood_deep', SW_D)) +
      ellipse(n(w / 2 - 2), n(-h / 2), n(h / 2 - 3), n(h / 2 - 7), solid('wood', 'wood_deep', SW_H)) +
      pathEl(`M${n(-w / 2 + 14)} ${n(-h * 0.72)}q${n(w * 0.22)} 10 ${n(w * 0.4)} 0`, line('wood_deep', SW_H)) +
      pathEl(`M${n(-w / 2 + 10)} ${n(-h * 0.32)}q${n(w * 0.3)} -8 ${n(w * 0.55)} 0`, line('wood_deep', SW_H)) +
      ellipse(n(-w * 0.28), n(-h - 4), 20, 10, solid('leafy', 'leafy_deep', SW_H)) +
      ellipse(n(w * 0.05), n(-h - 7), 16, 9, solid('leafy', 'leafy_deep', SW_H)) +
      ellipse(n(w * 0.3), n(-h - 3), 14, 8, solid('leafy', 'leafy_deep', SW_H));
  },

  // A handheld fishing net on a too-long cane — a held prop, not a ground one.
  fishing_net: (o) => {
    const len = o.len || 150;
    return pathEl(`M0 0L${n(-10)} ${n(-len)}`, line('wood_deep', SW)) +
      ellipse(-10, n(-len - 26), 34, 24, line('metal_deep', SW_D)) +
      pathEl(`M${n(-34)} ${n(-len - 30)}q24 30 0 48M${n(-10)} ${n(-len - 50)}q18 26 0 46M14 ${n(-len - 30)}q-24 30 0 48`,
        Object.assign({}, line('metal_deep', SW_H), { opacity: 0.6 }));
  },

  // A small wooden toy boat. o.sail (default true) adds a leaf hoisted as a
  // sail; pass sail:false for an empty/upturned hull. o.hullKey (default
  // 'brick') picks the hull colour — pass 'red' for a repainted/bright hull.
  // o.chipped adds a couple of pale paint-chip nicks along the hull (b384 —
  // "well loved, chipped paint"). o.reflection draws a faint upside-down
  // copy of the hull beneath the waterline, for open-water pages.
  boat: (o) => {
    const w = o.w || 110, h = o.h || 36;
    const hullKey = o.hullKey || 'brick', hullDeep = `${hullKey}_deep`;
    const hull = pathEl(`M${n(-w / 2)} 0q${n(w * 0.04)} ${n(h)} ${n(w * 0.46)} ${n(h)}q${n(w * 0.42)} 0 ${n(w * 0.46)} ${n(-h)}z`,
      solid(hullKey, hullDeep, SW_D));
    const chips = o.chipped
      ? pathEl(`M${n(-w * 0.2)} ${n(h * 0.5)}l8 4-2 6z`, { fill: c('paper'), stroke: 'none' }) +
        pathEl(`M${n(w * 0.22)} ${n(h * 0.3)}l-6 6-6-2z`, { fill: c('paper'), stroke: 'none' })
      : '';
    const reflection = o.reflection
      ? ellipse(0, n(h * 1.6), n(w * 0.42), n(h * 0.55), { fill: c(hullKey), opacity: 0.25, stroke: 'none' })
      : '';
    if (o.sail === false) return reflection + hull + chips;
    const mastH = o.mastH || 92, sailKey = o.sailKey || 'leafy';
    return reflection + hull + chips +
      pathEl(`M0 0V${n(-mastH)}`, line('wood_deep', SW_D)) +
      pathEl(`M0 ${n(-mastH + 6)}q${n(w * 0.34)} ${n(mastH * 0.18)} 0 ${n(mastH * 0.74)}z`, solid(sailKey, `${sailKey}_deep`, SW_H));
  },

  // A squat wooden toy tugboat — no sail (distinct from the sailing `boat`),
  // a boxy cabin and a short funnel. Moss's toy, 25-the-toy-boat.
  tug: (o) => {
    const w = o.w || 92, h = o.h || 30;
    return pathEl(`M${n(-w / 2)} 0q${n(w * 0.04)} ${n(h)} ${n(w * 0.46)} ${n(h)}q${n(w * 0.42)} 0 ${n(w * 0.46)} ${n(-h)}z`,
      solid('wood', 'wood_deep', SW_D)) +
      rrect(n(-w * 0.16), n(-h - 24), n(w * 0.34), 24, R.sm, solid('brick', 'brick_deep', SW_D)) +
      rrect(n(-w * 0.02), n(-h - 38), 9, 16, R.sm, solid('metal', 'metal_deep', SW_H));
  },

  // A rainbow — built from five EXISTING palette tones (never a new hex),
  // drawn as thick round-capped strokes using the band width already declared
  // in line.fill_stroke_widths, same convention as the bee's belly bands.
  rainbow: (o) => {
    const r = o.r || 150;
    const bands = ['petal', 'sun', 'leafy', 'water', 'plum'];
    const arcPath = (rad) => {
      const pts = [];
      for (let i = 0; i <= 20; i++) {
        const a = Math.PI * (1 - i / 20);
        pts.push(`${n(Math.cos(a) * rad)} ${n(-Math.sin(a) * rad)}`);
      }
      return 'M' + pts.join('L');
    };
    return bands.map((key, i) => pathEl(arcPath(r - i * 13),
      { fill: 'none', stroke: c(key), 'stroke-width': 11, 'stroke-linecap': 'round' })).join('');
  },

  // A shower of rain — diagonal hairlines across a region, its own prop
  // (usually front layer) so a page can choose how heavy it falls.
  rain: (o) => {
    const w = o.w || 640, h = o.h || 300, count = o.count || 14;
    let m = '';
    for (let i = 0; i < count; i++) {
      const x = -w / 2 + (w / count) * i + (i % 2 ? 10 : 0);
      m += pathEl(`M${n(x)} ${n(-h / 2)}l-18 ${n(h)}`, line('water_deep', SW_H));
    }
    return m;
  },

  // One small rising bubble — scattered for an underwater trail.
  bubble: () => circle(0, 0, 7, solid('water', 'water_deep', SW_H)),

  // A big gable barn — the farm set's main building.
  barn: (o) => {
    const w = o.w || 220, h = o.h || 170, roof = h * 0.36;
    return rrect(n(-w / 2), n(-h + roof), w, n(h - roof), R.sm, solid('brick', 'brick_deep', SW_D)) +
      pathEl(`M${n(-w / 2 - 12)} ${n(-h + roof)}L0 ${n(-h - 10)}L${n(w / 2 + 12)} ${n(-h + roof)}z`, solid('brick', 'brick_deep', SW_D)) +
      rrect(n(-w * 0.1), n(-h * 0.5), n(w * 0.2), n(h * 0.5), R.sm, solid('earth', 'earth_deep', SW_D)) +
      pathEl(`M${n(-w * 0.1)} ${n(-h * 0.25)}h${n(w * 0.2)}`, line('earth_deep', SW_H)) +
      circle(0, n(-h * 0.75), n(w * 0.07), solid('earth', 'earth_deep', SW_H)) +
      pathEl(`M${n(-w * 0.07)} ${n(-h * 0.75)}h${n(w * 0.14)}M0 ${n(-h * 0.75 - w * 0.07)}v${n(w * 0.14)}`, line('earth_deep', SW_H));
  },

  // A wide farm gate between two posts — horizontal rails and a diagonal
  // brace, distinct from the small ornamental garden "fence".
  farm_gate: (o) => {
    const w = o.w || 160, h = o.h || 90;
    let m = rrect(n(-w / 2 - 10), -h, 14, h, R.sm, solid('wood', 'wood_deep', SW_D)) +
      rrect(n(w / 2 - 4), -h, 14, h, R.sm, solid('wood', 'wood_deep', SW_D));
    [0.18, 0.5, 0.82].forEach((f) => {
      m += rrect(n(-w / 2), n(-h + h * f - 6), w, 12, R.sm, solid('wood', 'wood_deep', SW_H));
    });
    m += pathEl(`M${n(-w / 2 + 4)} ${n(-h + 8)}L${n(w / 2 - 4)} -8`, line('wood_deep', SW_H));
    return m;
  },

  // One corn stalk — tall, a few long filled leaf blades, a cob near the top
  // with a wispy husk tassel. Place several to read as a field or a row.
  corn: (o) => {
    const h = o.h || 170;
    const leafAt = (y, len, dir) => pathEl(
      `M0 ${n(y)}q${n(dir * len * 0.3)} ${n(-len * 0.15)} ${n(dir * len)} ${n(-len * 0.55)}q${n(-dir * len * 0.1)} ${n(len * 0.3)} ${n(-dir * len)} ${n(len * 0.55)}z`,
      solid('leafy', 'leafy_deep', SW_D));
    const cobY = -h * 0.74, cobH = h * 0.26;
    return pathEl(`M0 0V${n(-h)}`, line('wood_deep', SW_D)) +
      leafAt(n(-h * 0.18), h * 0.4, -1) +
      leafAt(n(-h * 0.42), h * 0.42, 1) +
      leafAt(n(-h * 0.62), h * 0.3, -1) +
      rrect(n(-h * 0.07), n(cobY), n(h * 0.14), n(cobH), R.sm, solid('sun', 'sun_deep', SW_H)) +
      pathEl(`M${n(-h * 0.07)} ${n(cobY + 4)}h${n(h * 0.14)}M${n(-h * 0.07)} ${n(cobY + cobH * 0.4)}h${n(h * 0.14)}M${n(-h * 0.07)} ${n(cobY + cobH * 0.7)}h${n(h * 0.14)}`, line('sun_deep', SW_H)) +
      pathEl(`M${n(-h * 0.05)} ${n(cobY)}q-10 -14 0-22M${n(h * 0.05)} ${n(cobY)}q10 -14 0-22`, line('leafy_deep', SW_H));
  },

  // A single leaf, close up — a pointed oval with a centre vein. Added
  // b382 so "close on a single wet leaf" pages can show an actual leaf
  // rather than a generic bush silhouette.
  leaf_single: () => pathEl('M0 -34q20 10 20 34q0 22-20 32q-20-10-20-32q0-24 20-34z', solid('leafy', 'leafy_deep', SW_D)) +
    pathEl('M0 -30V30', line('leafy_deep', SW_H)),

  // A plain grey boulder — bigger and squarer than a pebble, for sitting on.
  rock: (o) => {
    const w = o.w || 86, h = o.h || 58;
    return pathEl(`M${n(-w / 2)} 0q-6 ${n(-h * 0.7)} ${n(w * 0.3)} ${n(-h)}q${n(w * 0.4)} ${n(-h * 0.22)} ${n(w * 0.7)} 0q${n(w * 0.1)} ${n(h * 0.5)} 0 ${n(h)}z`,
      solid('metal', 'metal_deep', SW_D)) +
      pathEl(`M${n(-w * 0.15)} ${n(-h * 0.7)}q${n(w * 0.2)} -10 ${n(w * 0.4)} 0`, line('metal_deep', SW_H));
  },

  // A single wellington boot — rounded foot, turned-down cuff at the top.
  welly_boot: (o) => {
    const h = o.h || 60, w = o.w || 34;
    return pathEl(`M${n(-w / 2)} 0q-2 ${n(-h * 0.18)} ${n(w * 0.3)} ${n(-h * 0.18)}h${n(w * 0.5)}V${n(-h)}h${n(-w)}z`,
      solid('leafy', 'leafy_deep', SW_D)) +
      rrect(n(-w / 2 - 2), n(-h - 10), n(w + 4), 14, R.sm, solid('leafy', 'leafy_deep', SW_H));
  },

  // A small farmhouse — bigger and home-ish, not a store like the shed.
  // o.lit (default true) lights its two windows warm for a night scene.
  farmhouse: (o) => {
    const w = o.w || 190, h = o.h || 150, roof = h * 0.32;
    const lit = o.lit !== false;
    return rrect(n(-w / 2), n(-h + roof), w, n(h - roof), R.sm, solid('earth', 'earth_deep', SW_D)) +
      pathEl(`M${n(-w / 2 - 10)} ${n(-h + roof)}L0 ${n(-h - 8)}L${n(w / 2 + 10)} ${n(-h + roof)}z`, solid('brick', 'brick_deep', SW_D)) +
      rrect(n(-w * 0.1), n(-h * 0.42), n(w * 0.2), n(h * 0.42), R.sm, solid('wood', 'wood_deep', SW_H)) +
      rrect(n(-w * 0.34), n(-h * 0.62), n(w * 0.16), n(h * 0.2), R.sm, solid(lit ? 'sun' : 'sky', 'wood_deep', SW_H)) +
      rrect(n(w * 0.2), n(-h * 0.62), n(w * 0.16), n(h * 0.2), R.sm, solid(lit ? 'sun' : 'sky', 'wood_deep', SW_H));
  },

  // A small coin, half-buried, catching the light.
  coin: () => circle(0, 0, 15, solid('sun', 'sun_deep', SW_D)) +
    pathEl('M-7 -3q7-8 14 0', line('sun_deep', SW_H)),

  // An old wooden kitchen chair left outdoors — side view, slightly worn.
  chair: (o) => {
    const h = o.h || 100, w = o.w || 56;
    return rrect(n(-w / 2), n(-h * 0.42), w, 12, R.sm, solid('wood', 'wood_deep', SW_D)) +
      rrect(n(-w / 2), -h, 12, n(h * 0.6), R.sm, solid('wood', 'wood_deep', SW_H)) +
      pathEl(`M${n(-w / 2 + 2)} ${n(-h * 0.9)}h8M${n(-w / 2 + 2)} ${n(-h * 0.7)}h8`, line('wood_deep', SW_H)) +
      rrect(n(w / 2 - 6), n(-h * 0.3), 6, n(h * 0.3), R.sm, solid('wood', 'wood_deep', SW_H)) +
      rrect(n(-w / 2), n(-h * 0.3), 6, n(h * 0.3), R.sm, solid('wood', 'wood_deep', SW_H));
  },

  // A dug vegetable patch — bare earth with tilled furrow ridges and small
  // leafy veg tufts growing in rows along the top.
  vegetable_patch: (o) => {
    const w = o.w || 220, h = o.h || 60;
    let m = rrect(n(-w / 2), -h, w, h, R.sm, solid('earth', 'earth_deep', SW_D));
    for (let x = -w / 2 + 16; x < w / 2 - 10; x += w / 5) {
      m += pathEl(`M${n(x - 10)} ${n(-h + 14)}q10 -7 20 0`, line('earth_deep', SW_H));
      m += ellipse(n(x + w / 10), n(-h - 4), 16, 12, solid('leafy', 'leafy_deep', SW_H));
    }
    return m;
  },

  // Dot — a PROP creature (not cast), an enormous soppy brown dog with a
  // white patch over one eye. Reused by any later book needing a big friendly
  // dog. o.pose: 'sit' (default) | 'squashed' | 'dig' | 'sleep'.
  // Redrawn b382 — batch 1 review: "a brown blob; legs barely visible, no
  // clear ears/tail". Fixed with the species cues a child names at a glance:
  // visible legs with paws, a long muzzle with a dark nose tip, one big
  // floppy ear that actually droops past the jaw, and a thick wagging tail.
  dog: (o) => {
    const pose = o.pose || 'sit';
    const patchAt = (hx, hy) => pathEl(
      `M${n(hx - 20)} ${n(hy - 20)}a22 22 0 0 1 26 8 22 22 0 0 1-16 20 18 18 0 0 1-10-28z`,
      solid('white', 'white_deep', SW_H));
    // A long rounded muzzle (not a same-colour blob) with a dark nose tip —
    // the single cue a 3-year-old uses to name "dog".
    const muzzleAt = (hx, hy, flip) => {
      const s = flip ? -1 : 1;
      return pathEl(`M${n(hx)} ${n(hy + 4)}q${n(s * 28)} -6 ${n(s * 40)} 8q${n(s * 2)} 14 ${n(-s * 12)} 18q${n(-s * 24)} 4 ${n(-s * 28)} -8z`,
        solid('sand', 'sand_deep', SW_D)) +
        ellipse(n(hx + s * 38), n(hy + 12), 7, 5.5, { fill: c('ink'), stroke: 'none' });
    };
    // A big floppy ear that droops well past the jaw-line — long, wide,
    // rounded. This was the main "blob" bug: the old ear was a thin curl.
    const earAt = (hx, hy, flip) => {
      const s = flip ? -1 : 1;
      return pathEl(`M${n(hx - s * 6)} ${n(hy - 22)}q${n(s * 28)} 2 ${n(s * 24)} 38q${n(-s * 4)} 24 ${n(-s * 22)} 28q${n(-s * 12)} -20 ${n(-s * 14)} -42q${n(-s * 2)} -16 ${n(s * 12)} -24z`,
        solid('wood', 'wood_deep', SW_D));
    };
    const eyeAt = (hx, hy, mode) => eye(hx + 4, hy - 4, mode, 0.95, 'wood');
    // A thick wagging tail with a rounded tip — up=true lifts it for a happy
    // wag, false sweeps it low and back.
    const tailAt = (x, y, up) => pathEl(
      `M${n(x)} ${n(y)}q${n(-22)} ${n(up ? -34 : 10)} ${n(-4)} ${n(up ? -50 : 24)}q${n(18)} ${n(up ? 8 : 6)} ${n(22)} ${n(up ? -16 : -6)}z`,
      solid('wood', 'wood_deep', SW_D));
    // Two straight legs with a small flattened paw — visible, not implied.
    const legsAt = (x1, x2, topY, footY) =>
      rrect(n(x1 - 8), n(topY), 16, n(footY - topY), R.sm, solid('wood', 'wood_deep', SW_D)) +
      rrect(n(x2 - 8), n(topY - 6), 16, n(footY - topY + 6), R.sm, solid('wood', 'wood_deep', SW_D)) +
      ellipse(n(x1), n(footY), 11, 6, solid('wood', 'wood_deep', SW_H)) +
      ellipse(n(x2), n(footY), 11, 6, solid('wood', 'wood_deep', SW_H));

    if (pose === 'squashed') {
      const hx = 66, hy = -44;
      // Paws splayed out beyond the flattened body on every side — the
      // story's own joke ("paws hanging off all four sides").
      const paws = ellipse(96, -6, 14, 7, solid('wood', 'wood_deep', SW_H)) +
        ellipse(70, 4, 13, 7, solid('wood', 'wood_deep', SW_H)) +
        ellipse(-96, -8, 14, 7, solid('wood', 'wood_deep', SW_H)) +
        ellipse(-72, 4, 13, 7, solid('wood', 'wood_deep', SW_H));
      return ellipse(-4, -18, 94, 22, solid('wood', 'wood_deep', SW_D)) + paws +
        circle(hx, hy, 32, solid('wood', 'wood_deep', SW_D)) +
        patchAt(hx, hy) + muzzleAt(hx, hy, false) + earAt(hx, hy, false) +
        eyeAt(hx, hy, 'happy') + tailAt(-80, -22, false);
    }
    if (pose === 'dig') {
      const hx = -54, hy = -58;
      // Braced hind legs up in the air, mid-dig.
      const hindLegs = rrect(30, -82, 15, 30, R.sm, solid('wood', 'wood_deep', SW_D)) +
        rrect(54, -78, 15, 28, R.sm, solid('wood', 'wood_deep', SW_D));
      return ellipse(16, -28, 78, 38, solid('wood', 'wood_deep', SW_D)) + hindLegs +
        circle(hx, hy, 28, solid('wood', 'wood_deep', SW_D)) +
        patchAt(hx, hy) + muzzleAt(hx, hy, true) +
        pathEl(`M${n(hx + 2)} ${n(hy - 24)}q-10 14 0 26`, line('wood_deep', SW_D)) +
        tailAt(78, -40, true);
    }
    if (pose === 'sleep') {
      const hx = 56, hy = -44;
      return ellipse(-6, -24, 88, 30, solid('wood', 'wood_deep', SW_D)) +
        ellipse(-70, -8, 16, 7, solid('wood', 'wood_deep', SW_H)) +
        circle(hx, hy, 30, solid('wood', 'wood_deep', SW_D)) +
        patchAt(hx, hy) + muzzleAt(hx, hy, false) + earAt(hx, hy, false) +
        eyeAt(hx, hy, 'sleepy');
    }
    // 'sit' (default): square obedient-dog pose, legs planted, tail up in a wag.
    const hx = 74, hy = -82;
    return ellipse(0, -50, 78, 52, solid('wood', 'wood_deep', SW_D)) +
      ellipse(-46, -34, 36, 34, solid('wood', 'wood_deep', SW_D)) +
      legsAt(18, 46, -46, -2) +
      circle(hx, hy, 38, solid('wood', 'wood_deep', SW_D)) +
      patchAt(hx, hy) + muzzleAt(hx, hy, false) + earAt(hx, hy, false) +
      eyeAt(hx, hy, 'happy') + tailAt(-56, -56, true);
  },

  // A small fish, swimming (or held). o.flip mirrors its heading.
  // Fixed single orientation — mirror it with the scene's own "flip" on the
  // prop entry (renderScene already mirrors the whole placed group; a prop
  // that ALSO self-mirrors on o.flip cancels that out to no visible flip at
  // all). Fixed b382 — see the fox/goat/cow note below, same bug.
  fish: () => pathEl('M-22 0q14 -16 44 0q-30 16 -44 0z', solid('red', 'red_deep', SW_D)) +
    pathEl('M-22 0l-14 -10v20z', solid('red', 'red_deep', SW_H)) +
    circle(14, -3, 3, { fill: c('ink'), stroke: 'none' }),

  // A small shiny beetle on a leaf.
  beetle: () => ellipse(0, -8, 18, 14, solid('leaf', 'leaf_deep', SW_D)) +
    pathEl('M0 -20V4', line('leaf_deep', SW_H)) +
    circle(0, -20, 5, solid('leaf', 'leaf_deep', SW_H)),

  // A ladybird — red shell, three black spots, dark head.
  ladybird: () => ellipse(0, 0, 14, 11, solid('red', 'red_deep', SW_D)) +
    pathEl('M0 -11V11', line('red_deep', SW_H)) +
    circle(-5, -2, 2.2, { fill: c('ink'), stroke: 'none' }) +
    circle(5, 2, 2.2, { fill: c('ink'), stroke: 'none' }) +
    circle(-4, 6, 1.8, { fill: c('ink'), stroke: 'none' }) +
    circle(0, -9, 4, { fill: c('ink'), stroke: 'none' }),

  // A goat, standing, side-on. o.flip mirrors it; o.wet adds a few parted-fur
  // lines for "soaked coat" pages.
  // Redrawn b382 — batch 1 review: "reads as an insect — white oval, stick
  // legs, antennae-like horns". Fixed: solid legs with hooves (not hairlines),
  // thick curved filled horns (not thin curls), and a chin beard — the three
  // cues that separate a goat from every other four-legged prop in the kit.
  // Fixed single orientation — mirror with the scene's own prop "flip"
  // (renderScene already mirrors the placed group; a prop that ALSO
  // self-mirrors on o.flip cancels that out to no visible flip at all —
  // this is what made the-dark-farm's "fox ... glancing back" page never
  // actually turn around). Fixed b382.
  goat: (o) => {
    const leg = (x, topY) => rrect(n(x - 7), n(topY), 14, n(-topY), R.sm, solid('white', 'white_deep', SW_D)) +
      pathEl(`M${n(x - 7)} 0q7-6 14 0q-3 6-7 6t-7-6z`, solid('earth', 'earth_deep', SW_H));
    // A thin curved stroke, not a filled wedge — a filled horn kept reading
    // as a floppy ear (b382 first attempt). A simple backswept line is what
    // actually reads as "horn" at this scale.
    const horn = (dx, sweep) => pathEl(
      `M${n(58 + dx)} -90q${n(-9)} ${n(-sweep * 0.5)} ${n(-15)} ${n(-sweep)}`,
      { fill: 'none', stroke: c('earth_deep'), 'stroke-width': SW });
    return leg(-48, -14) + leg(-26, -16) + leg(22, -14) + leg(42, -16) +
      ellipse(0, -46, 56, 34, solid('white', 'white_deep', SW_D)) +
      circle(58, -66, 26, solid('white', 'white_deep', SW_D)) +
      pathEl('M36 -74q-10 -6 -16 4M76 -74q10 -6 16 4', solid('white', 'white_deep', SW_H)) +
      horn(4, 32) + horn(16, 26) +
      // Chin beard — a chunky tapered tuft hanging below the jaw, the
      // goat's other defining cue, enlarged b382 so it actually reads.
      pathEl('M66 -50q10 4 10 16q0 10 -6 16q-8 -6 -10 -18q-2 -8 6 -14z', solid('earth', 'earth_deep', SW_H)) +
      eye(70, -70, 'open', 0.9, 'white') +
      (o.wet ? pathEl('M-20 -50q6 10 0 20M6 -54q6 10 0 20M28 -50q6 10 0 20', line('white_deep', SW_H)) : '');
  },

  // A fox, slipping past low and quick. o.flip mirrors its heading.
  // Redrawn b382 — batch 1 review: "an orange oval with a dot eye". Fixed
  // with a proper head (the old version had none — ears and snout were stuck
  // straight onto the body), pointed triangular ears, a long tapered snout
  // with a dark nose tip, a bigger white chest, and a white-tipped brush.
  // Fixed single orientation — see the note on `goat` above for why these
  // creature props no longer read o.flip themselves.
  fox: () => {
    const hx = 60, hy = -56;
    return pathEl('M-18 0V-20M8 0V-22', solid('brick', 'brick_deep', SW_H)) +
      ellipse(0, -34, 58, 26, solid('brick', 'brick_deep', SW_D)) +
      ellipse(30, -18, 22, 17, solid('white', 'white_deep', SW_H)) +
      // head, distinct from the body — the single biggest fix
      circle(hx, hy, 27, solid('brick', 'brick_deep', SW_D)) +
      // long tapered snout with a dark nose tip
      pathEl(`M${n(hx + 16)} ${n(hy + 8)}q30 -2 42 8q-10 12 -36 10z`, solid('brick', 'brick_deep', SW_D)) +
      ellipse(n(hx + 56), n(hy + 14), 6.5, 5, { fill: c('ink'), stroke: 'none' }) +
      // two pointed, upright ears
      pathEl(`M${n(hx - 20)} ${n(hy - 16)}L${n(hx - 32)} ${n(hy - 50)}L${n(hx - 2)} ${n(hy - 26)}z`, solid('brick', 'brick_deep', SW_D)) +
      pathEl(`M${n(hx + 10)} ${n(hy - 22)}L${n(hx + 6)} ${n(hy - 50)}L${n(hx + 26)} ${n(hy - 28)}z`, solid('brick', 'brick_deep', SW_D)) +
      // simple running legs, angled for quick motion
      pathEl('M-30 -16q-6 10 -4 16M-6 -14q4 10 2 16', line('brick_deep', SW_D)) +
      // bushy brush with a white tip, swept behind
      pathEl('M-50 -34q-30 -4 -46 -26q4 20 26 30z', solid('brick', 'brick_deep', SW_D)) +
      ellipse(-94, -58, 15, 11, solid('white', 'white_deep', SW_H)) +
      eye(n(hx + 10), n(hy - 4), 'open', 0.8, 'brick');
  },

  // A cow, standing — patchy coat, long muzzle, small horns, four solid
  // legs. o.flip mirrors it.
  // Redrawn b382 — batch 1 review: "only reads as a cow because of the
  // spots; the head is a circle". Fixed with a proper muzzle (with
  // nostrils), solid legs with hooves (not hairlines), and small filled
  // horns (not hairline curls). Spots and ears were already fine — kept.
  // Fixed single orientation — see the note on `goat` above for why these
  // creature props no longer read o.flip themselves.
  cow: () => {
    const leg = (x, topY) => rrect(n(x - 8), n(topY), 16, n(-topY), R.sm, solid('white', 'white_deep', SW_D)) +
      pathEl(`M${n(x - 8)} 0q8-6 16 0q-4 6-8 6t-8-6z`, solid('earth', 'earth_deep', SW_H));
    const hx = 76, hy = -70;
    return leg(-46, -18) + leg(-18, -20) + leg(30, -18) + leg(54, -20) +
      ellipse(0, -50, 68, 38, solid('white', 'white_deep', SW_D)) +
      ellipse(-14, -56, 22, 16, solid('wood', 'wood_deep', SW_H)) +
      ellipse(26, -42, 18, 14, solid('wood', 'wood_deep', SW_H)) +
      circle(hx, hy, 26, solid('white', 'white_deep', SW_D)) +
      // long muzzle with two nostril dots — the main fix
      pathEl(`M${n(hx + 10)} ${n(hy + 8)}q34 -4 40 10q2 14 -14 18q-28 2 -30 -12z`,
        solid('sand', 'sand_deep', SW_D)) +
      circle(n(hx + 44), n(hy + 18), 2.6, { fill: c('ink'), stroke: 'none' }) +
      circle(n(hx + 30), n(hy + 20), 2.6, { fill: c('ink'), stroke: 'none' }) +
      // one clear ear flap, drawn big enough to read on its own
      pathEl(`M${n(hx - 10)} ${n(hy - 18)}q-14 -14 -6 -34q14 4 22 20q4 10 -10 14z`,
        solid('white', 'white_deep', SW_D)) +
      // two SHORT horn nubs close together at the top of the head — small,
      // unlike the goat's long swept-back horns, per the brief's own "pair
      // of horns" (not a rack). Fixed b382 — these were reading as a second
      // pair of ears before.
      pathEl(`M${n(hx + 2)} ${n(hy - 24)}q-2 -9 3 -15q5 4 3 11q-1 5 -6 4z`, solid('earth', 'earth_deep', SW_H)) +
      pathEl(`M${n(hx + 13)} ${n(hy - 24)}q-2 -9 3 -15q5 4 3 11q-1 5 -6 4z`, solid('earth', 'earth_deep', SW_H)) +
      eye(88, -74, 'open', 1, 'white');
  },

  /* -------------------------------------------------------------------------
   * Added b382 — props for books 9-16 (PROPS.md updated to match).
   * ---------------------------------------------------------------------- */

  // A burst of frost crystals, drawn as fern-like radiating hairlines —
  // the b248 convention of drawing an effect rather than printing a symbol.
  // o.n controls how many fronds; works at any scale from a single blade
  // close-up to a dusting along a pond edge.
  frost: (o) => {
    const count = o.n || 5, len = o.len || 26;
    let m = '';
    for (let i = 0; i < count; i++) {
      const a = (-90 + (i - (count - 1) / 2) * 22) * Math.PI / 180;
      const L = len * (0.75 + 0.25 * Math.abs(Math.sin(i * 1.7)));
      const x2 = Math.cos(a) * L, y2 = Math.sin(a) * L;
      m += pathEl(`M0 0L${n(x2)} ${n(y2)}`, line('white_deep', SW_H));
      m += pathEl(`M${n(x2 * 0.5)} ${n(y2 * 0.5)}l${n(-y2 * 0.14)} ${n(x2 * 0.14)}M${n(x2 * 0.5)} ${n(y2 * 0.5)}l${n(y2 * 0.14)} ${n(-x2 * 0.14)}`,
        line('white_deep', SW_H));
    }
    return m;
  },

  // A twig snapped clean in two, with a small frost spray at the break.
  twig_snap: () => pathEl('M-20 -2l-16-18', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M10 4l22 12', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M-4 -8l5 7M3 -7l-3 9M-1 1l7 2', line('white_deep', SW_H)),

  // A brown splash, same construction as the water `splash` but earthy —
  // for a mud puddle rather than a pond.
  mud_splash: () => pathEl('M-34 2q6-24 16-30 4 16 12 20 4-18 14-24 2 18 10 22 6-14 16-16', solid('earth', 'earth_deep', SW_D)) +
    ellipse(-26, -44, 6, 8, solid('earth', 'earth_deep', SW_H)) +
    ellipse(2, -56, 7, 9, solid('earth', 'earth_deep', SW_H)) +
    ellipse(28, -40, 5, 7, solid('earth', 'earth_deep', SW_H)),

  // A shallow mud puddle — same shape as `puddle` but earth-toned, for
  // "fell in the mud" pages where the water token would read as a pond.
  mud: (o) => {
    const w = o.w || 120, h = o.h || 28;
    return ellipse(0, 0, w / 2, h / 2, solid('earth', 'earth_deep', SW_D)) +
      ellipse(n(-w / 8), n(-h / 6), n(w / 7), n(h / 9), { fill: c('earth_deep'), opacity: 0.35, stroke: 'none' });
  },

  // A stack of round golden hay bales — two at the base, one on top.
  hay_bales: () => {
    const bale = (x, y, r) => circle(x, y, r, solid('wood', 'wood_deep', SW_D)) +
      pathEl(`M${n(x - r * 0.6)} ${n(y)}q${n(r * 0.6)} ${n(-r * 0.3)} ${n(r * 1.2)} 0`, line('wood_deep', SW_H)) +
      pathEl(`M${n(x - r * 0.5)} ${n(y + r * 0.42)}q${n(r * 0.5)} ${n(-r * 0.2)} ${n(r)} 0`, line('wood_deep', SW_H));
    return bale(-36, -34, 34) + bale(36, -34, 34) + bale(0, -96, 34);
  },

  // A shallow round paddling pool — a raised rim makes it a pool, not a
  // puddle on the ground.
  paddling_pool: (o) => {
    const rx = o.rx || 110, ry = o.ry || 34;
    return ellipse(0, 6, n(rx + 10), n(ry + 8), solid('water', 'water_deep', SW_D)) +
      ellipse(0, 0, rx, ry, solid('water', 'water_deep', SW_H)) +
      ellipse(n(-rx * 0.3), n(-ry * 0.25), n(rx * 0.25), n(ry * 0.2), { fill: c('white'), opacity: 0.4, stroke: 'none' });
  },

  // Pip's own nest, lined with ivy leaves — distinct from the generic
  // twiggy `nest` prop.
  ivy_nest: () => pathEl('M-46 6q0-30 46-30t46 30q-10 12-46 12t-46-12z', solid('wood', 'wood_deep', SW_D)) +
    [-34, -10, 14, 34].map((x) => ellipse(x, -20, 10, 7, solid('leafy', 'leafy_deep', SW_H))).join('') +
    pathEl('M-36 -6q22-8 72 0M-30 4q26-6 60 0', line('wood_deep', SW_H)),

  // A cutaway earth den under a tree root — a dry hollow interior, a root
  // arc on top.
  den: (o) => {
    const w = o.w || 180, h = o.h || 130;
    return pathEl(`M${n(-w / 2)} 4Q${n(-w / 2)} ${n(-h)} 0 ${n(-h)}Q${n(w / 2)} ${n(-h)} ${n(w / 2)} 4z`, solid('earth', 'earth_deep', SW_D)) +
      ellipse(0, n(-h * 0.32), n(w * 0.3), n(h * 0.32), solid('paper', 'earth_deep', SW_D)) +
      pathEl(`M${n(-w * 0.3)} ${n(-h * 0.92)}q${n(w * 0.3)} -14 ${n(w * 0.6)} 0`, line('wood_deep', SW_H)) +
      pathEl(`M${n(-w * 0.16)} ${n(-h * 0.1)}q${n(w * 0.16)} 10 ${n(w * 0.32)} 0`, line('earth_deep', SW_H));
  },

  // A hazelnut, held or lying on the ground.
  nut: () => pathEl('M-14 2q-4-20 14-24q18 4 14 24q-4 10-14 10t-14-10z', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M-10 -18q10-8 20 0', line('wood_deep', SW_H)),

  // A small bright red hand bell, hanging from a twig.
  // Redrawn b384 — batch-2 review: "a red blob with a dot under it — reads as
  // an apple". Fixed with an actual bell silhouette: a wooden handle/loop at
  // the crown, a body that FLARES from a narrow top to a wide rim (not a
  // round blob), a dark filled ellipse for the open rim (same convention as
  // the tin's open end), and the clapper hanging visibly inside that opening.
  bell: () => pathEl('M0 -62V-44', line('wood_deep', SW_D)) +
    circle(0, -66, 6, solid('wood', 'wood_deep', SW_H)) +
    pathEl('M-9 -44q-21 4-25 24t4 22h60q8-2 4-22t-25-24q-9-8-18 0z', solid('red', 'red_deep', SW_D)) +
    ellipse(0, 2, 28, 8, { fill: c('red_deep'), stroke: 'none' }) +
    circle(0, 4, 7, solid('wood', 'wood_deep', SW_H)),

  // A ridiculous curly red wig — ONE dome silhouette with a scalloped curl
  // fringe along the bottom edge and a dark underside where it sits on a
  // head, plus a few raised curl bumps for texture.
  // Redrawn b384 — batch-2 review: "a cluster of overlapping red circles —
  // reads as berries or grapes". A real silhouette (dome + fringe + visible
  // opening) reads as a wig at a glance; loose circles never will.
  wig: () => pathEl(
    'M-40 2Q-46 -50 0 -54Q46 -50 40 2' +
    'Q32 -10 24 2Q16 -10 8 2Q0 -10 -8 2Q-16 -10 -24 2Q-32 -10 -40 2Z',
    solid('red', 'red_deep', SW_D)) +
    [-28, -10, 8, 26].map((x) => circle(x, -38, 9, solid('red', 'red_deep', SW_H))).join('') +
    ellipse(0, -2, 24, 8, { fill: c('red_deep'), stroke: 'none' }),

  // A small paper quiz card with a big tick — never a letter or a word.
  quiz_card: () => rrect(-24, -32, 48, 36, R.sm, solid('paper', 'ink', SW_D)) +
    pathEl('M-10 -16l7 10 16-20', { fill: 'none', stroke: c('leafy_deep'), 'stroke-width': SW_D }),

  // A sticky jam bun — bread base, glossy red jam on top.
  jam_bun: () => ellipse(0, 0, 36, 26, solid('wood', 'wood_deep', SW_D)) +
    pathEl('M-28 -6q28-20 56 0q-10 14-28 14t-28-14z', solid('red', 'red_deep', SW_D)) +
    ellipse(-6, -10, 6, 4, { fill: c('white'), opacity: 0.5, stroke: 'none' }),

  // A fig — the FRUIT (distinct from Fig the caterpillar), a small purple
  // teardrop. Placed several times, "exactly six and countable".
  fig_fruit: () => pathEl('M0 -22q14 4 14 20q0 16-14 20q-14-4-14-20q0-16 14-20z', solid('plum', 'plum_deep', SW_D)) +
    pathEl('M0 -22v-6', line('leafy_deep', SW_H)),

  // A cutaway hollow in a tree trunk — a dry cavity inside a slab of wood.
  oak_hollow: (o) => {
    const w = o.w || 200, h = o.h || 260;
    return rrect(n(-w / 2), n(-h), w, h, R.md, solid('wood', 'wood_deep', SW_D)) +
      pathEl(`M${n(-w * 0.22)} ${n(-h * 0.78)}q${n(-w * 0.1)} ${n(h * 0.18)} 0 ${n(h * 0.36)}q${n(w * 0.22)} ${n(h * 0.14)} ${n(w * 0.44)} 0q${n(w * 0.1)} ${n(-h * 0.18)} 0 ${n(-h * 0.36)}q${n(-w * 0.22)} ${n(-h * 0.12)} ${n(-w * 0.44)} 0z`,
        solid('earth', 'wood_deep', SW_D)) +
      pathEl(`M${n(-w * 0.16)} ${n(-h * 0.76)}q${n(w * 0.16)} 8 ${n(w * 0.32)} 0`, line('wood_deep', SW_H));
  },

  // A starburst of short commotion lines — for a tantrum/fuss that needs to
  // read as "bigger than the character having it", without inventing a new
  // pose geometry for one page.
  fuss: (o) => {
    const r1 = o.r1 || 32, r2 = o.r2 || 56, rays = o.rays || 7, rot = (o.rot || 0) * Math.PI / 180;
    let m = '';
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + rot;
      m += pathEl(`M${n(Math.cos(a) * r1)} ${n(Math.sin(a) * r1)}L${n(Math.cos(a) * r2)} ${n(Math.sin(a) * r2)}`,
        line('ink', SW_D));
    }
    return m;
  },

  // A translucent colour wash over whatever it is placed on — used ONCE,
  // for "Fig is a red bug" (heat haze), never to recolour a cast member's
  // own geometry. See DEPARTURES.md.
  heat_tint: (o) => ellipse(0, 0, o.rx || 40, o.ry || 30, { fill: c(o.key || 'red'), opacity: o.opacity != null ? o.opacity : 0.4, stroke: 'none' }),

  /* -------------------------------------------------------------------------
   * Added b383 — props for books 17-24 (PROPS.md updated to match). Farm
   * animals follow the same "species cues a child names it by" rule the
   * b382 goat/fox/cow/dog redraws established: solid legs, a real head, the
   * 2-3 features that separate this animal from every other prop.
   * ---------------------------------------------------------------------- */

  // A pig, standing side-on — round body, flat snout with two nostril dots,
  // small pointed ears, a curly tail. For 17-the-big-farm ("a pig? a hen?").
  pig: (o) => {
    const leg = (x, topY) => rrect(n(x - 7), n(topY), 14, n(-topY), R.sm, solid('petal', 'petal_deep', SW_D));
    const hx = 70, hy = -58;
    return leg(-40, -14) + leg(-16, -16) + leg(20, -14) + leg(40, -16) +
      ellipse(0, -46, 60, 36, solid('petal', 'petal_deep', SW_D)) +
      circle(hx, hy, 30, solid('petal', 'petal_deep', SW_D)) +
      // flat snout, a different tone so it reads against the body — same
      // convention the cow's muzzle uses.
      rrect(n(hx + 18), n(hy - 6), 26, 20, R.sm, solid('sand', 'sand_deep', SW_D)) +
      circle(n(hx + 26), n(hy + 2), 2.6, { fill: c('sand_deep'), stroke: 'none' }) +
      circle(n(hx + 36), n(hy + 2), 2.6, { fill: c('sand_deep'), stroke: 'none' }) +
      pathEl(`M${n(hx - 14)} ${n(hy - 24)}q-10 -14 2-22q12 4 14 20z`, solid('petal', 'petal_deep', SW_H)) +
      pathEl(`M${n(hx + 6)} ${n(hy - 26)}q-4 -14 8-20q10 6 8 22z`, solid('petal', 'petal_deep', SW_H)) +
      pathEl('M-58 -50q-14 -4 -10 -16q4 -10 14 -4q6 6 -4 12', line('petal_deep', SW_D)) +
      eye(n(hx + 4), n(hy - 6), 'open', 0.9, 'petal');
  },

  // A hen — round body, comb + wattle + a short curved beak, two thin legs
  // with forward toes. For 17-the-big-farm / 18-down-by-the-pond.
  hen: (o) => {
    const hx = 54, hy = -84;
    return pathEl('M-6 -4v-14M18 -4v-14', line('sun_deep', SW_D)) +
      pathEl('M-14 -4h16q2 6 -8 6t-8-6z', solid('sun', 'sun_deep', SW_H)) +
      pathEl('M10 -4h16q2 6 -8 6t-8-6z', solid('sun', 'sun_deep', SW_H)) +
      ellipse(0, -56, 46, 40, solid('white', 'white_deep', SW_D)) +
      circle(hx, hy, 22, solid('white', 'white_deep', SW_D)) +
      pathEl(`M${n(hx - 10)} ${n(hy - 20)}q-2 -14 6-16q4 8 0 14q6 -6 10 2q-4 6 -10 6z`, solid('red', 'red_deep', SW_H)) +
      ellipse(n(hx + 14), n(hy + 14), 6, 8, solid('red', 'red_deep', SW_H)) +
      pathEl(`M${n(hx + 18)} ${n(hy + 2)}l14 6-14 6z`, solid('sun', 'sun_deep', SW_D)) +
      eye(n(hx + 6), n(hy - 4), 'open', 0.8, 'white');
  },

  // A soft diagonal shaft of light — a wide translucent wedge, its lean
  // baked into the path itself (props can't rotate). For "one shaft of
  // dusty light" barn-interior pages.
  light_shaft: (o) => {
    const len = o.len || 220, w1 = o.w1 || 16, w2 = o.w2 || 90, lean = o.lean != null ? o.lean : 60;
    return pathEl(`M${n(-w1 / 2)} 0L${n(w1 / 2)} 0L${n(lean + w2 / 2)} ${n(len)}L${n(lean - w2 / 2)} ${n(len)}z`,
      { fill: c('sun'), opacity: o.opacity != null ? o.opacity : 0.28, stroke: 'none' });
  },

  // A few swept wind-lines — the b248 way of drawing "it was windy" without
  // a weather icon, same idea as `ripples`/`frost`.
  wind_lines: (o) => {
    const w = o.w || 460, count = o.n || 5;
    let m = '';
    for (let i = 0; i < count; i++) {
      const y = (i - (count - 1) / 2) * 26;
      const len = w * (0.6 + 0.4 * Math.abs(Math.sin(i * 1.3)));
      m += pathEl(`M${n(-len / 2)} ${n(y)}q${n(len * 0.3)} -10 ${n(len * 0.6)} 0q${n(len * 0.1)} 10 ${n(len * 0.4)} 2`,
        line('white_deep', SW_H));
    }
    return m;
  },

  // A string of small triangular bunting flags on a cord. For fun-at-the-fair.
  bunting: (o) => {
    const w = o.w || 260, sag = o.sag || 22, count = o.n || 9;
    const cols = ['red', 'sun', 'water', 'leafy'];
    let flags = '', pts = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count, x = -w / 2 + w * t, y = Math.sin(Math.PI * t) * sag;
      pts.push(`${n(x)} ${n(y)}`);
    }
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count, x = -w / 2 + w * t, y = Math.sin(Math.PI * t) * sag;
      const col = cols[i % cols.length];
      flags += pathEl(`M${n(x - 10)} ${n(y)}L${n(x + 10)} ${n(y)}L${n(x)} ${n(y + 22)}z`, solid(col, `${col}_deep`, SW_H));
    }
    return pathEl('M' + pts.join('L'), line('wood_deep', SW_H)) + flags;
  },

  // A peaked fairground tent, striped canvas, a small pennant on top.
  tent: (o) => {
    const w = o.w || 160, h = o.h || 150, peak = h * 0.55, col = o.col || 'red';
    let m = rrect(n(-w / 2), n(-h + peak), w, n(h - peak), R.sm, solid('paper', 'ink', SW_D));
    const stripes = 5;
    for (let i = 0; i < stripes; i++) {
      if (i % 2) continue;
      const x = -w / 2 + (w / stripes) * i;
      m += rrect(n(x), n(-h + peak), n(w / stripes), n(h - peak), 0, { fill: c(col), stroke: 'none' });
    }
    m += pathEl(`M${n(-w / 2 - 10)} ${n(-h + peak)}L0 ${n(-h)}L${n(w / 2 + 10)} ${n(-h + peak)}z`, solid(col, `${col}_deep`, SW_D));
    m += pathEl(`M0 ${n(-h)}V${n(-h - 24)}`, line('wood_deep', SW_H));
    m += pathEl(`M0 ${n(-h - 24)}l20 8-20 8z`, solid('water', 'water_deep', SW_H));
    return m;
  },

  // A distant fairground wheel — a ringed circle with spoke lines and small
  // gondola dots. Drawn small, background only.
  big_wheel: (o) => {
    const r = o.r || 70;
    let m = circle(0, n(-r), r, { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D }) +
      circle(0, n(-r), n(r * 0.7), { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x2 = Math.cos(a) * r, y2 = -r + Math.sin(a) * r;
      m += pathEl(`M0 ${n(-r)}L${n(x2)} ${n(y2)}`, line('metal_deep', SW_H));
      m += circle(n(x2), n(y2), 6, solid('red', 'red_deep', SW_H));
    }
    m += rrect(-8, -8, 16, n(r + 8), R.sm, solid('metal', 'metal_deep', SW_H));
    return m;
  },

  // A painted fairground swing-chair hung by a chain — the chain's top end
  // simply exits the frame (the kit draws no tower), so height is implied
  // by where the scene places it, not by drawing the whole ride.
  chair_swing: (o) => {
    const w = o.w || 70, h = o.h || 46, chain = o.chain || 120;
    return pathEl(`M-14 ${n(-h - chain)}L-6 ${n(-h)}M14 ${n(-h - chain)}L6 ${n(-h)}`, line('metal_deep', SW_H)) +
      rrect(n(-w / 2), n(-h), w, h, R.md, solid('red', 'red_deep', SW_D)) +
      rrect(n(-w / 2), n(-h - 10), w, 10, R.sm, solid('sun', 'sun_deep', SW_H));
  },

  // A simple friendly person — same construction as the cast (bold outline,
  // one eye, flat fill) but drawn plain and human: round head, a plain
  // apron/body, two simple arms. o.skin/o.shirt pick the tones (reusable for
  // any later "a person" brief with different colours).
  // Fixed b383 — flagged in PROPS.md after the b384 review caught the same
  // "floating head" bug in `child` before its own redraw: the torso top sat
  // at y=-94 but the head (hy=-150, r=30) floated 26 units above it with a
  // gap of bare page between them. hy moved to -118 so the head's own circle
  // overlaps the torso top by 6 units, same convention `child` now uses.
  stallholder: (o) => {
    const skin = o.skin || 'sand', shirt = o.shirt || 'water';
    const hx = 0, hy = -118;
    return rrect(-28, -94, 56, 94, R.md, solid(shirt, `${shirt}_deep`, SW_D)) +
      pathEl('M-28 -84q-16 6-16 30', { fill: 'none', stroke: c(`${shirt}_deep`), 'stroke-width': SW }) +
      pathEl('M28 -84q16 6 16 30', { fill: 'none', stroke: c(`${shirt}_deep`), 'stroke-width': SW }) +
      circle(hx, hy, 30, solid(skin, `${skin}_deep`, SW_D)) +
      ellipse(hx, n(hy - 24), 30, 13, solid('wood', 'wood_deep', SW_H)) +
      eye(n(hx + 8), n(hy + 2), 'happy', 0.85, skin);
  },

  // A single husked corn cob, drawn lying on its side (long axis
  // horizontal) so a small creature can sit astride it — distinct from the
  // standing field `corn` stalk.
  corn_cob: (o) => {
    const len = o.len || 150, r = o.r || 22;
    let m = rrect(n(-len / 2), n(-r), len, n(r * 2), r, solid('sun', 'sun_deep', SW_D));
    for (let i = 1; i < 5; i++) {
      const x = -len / 2 + (len / 5) * i;
      m += pathEl(`M${n(x)} ${n(-r + 3)}V${n(r - 3)}`, line('sun_deep', SW_H));
    }
    return m;
  },

  // A pointed party hat — a plain cone (no pattern, per the no-letters-or-
  // symbols rule) with a pompom tip.
  party_hat: (o) => pathEl('M-24 0q24-60 24-62q0 2 24 62z', solid('red', 'red_deep', SW_D)) +
    circle(0, -64, 9, solid('sun', 'sun_deep', SW_H)),

  // A single plain twig, slightly bent — for "carrying one twig". Distinct
  // from `twig_snap` (a broken one with a frost spray).
  twig: (o) => {
    const len = o.len || 60;
    return pathEl(`M${n(-len / 2)} 4q${n(len / 2)} -14 ${n(len)} -4`, line('wood_deep', SW)) +
      pathEl(`M${n(-len * 0.2)} 0l-6-8M${n(len * 0.15)} -8l-5-7`, line('wood_deep', SW_H));
  },

  // One small ant — three body segments, bent legs, two antennae. Place
  // several (offset x) for "a line of ants".
  ant: () => {
    const seg = (cx, r) => circle(cx, 0, r, solid('wood', 'wood_deep', SW_H));
    return seg(-10, 5) + seg(0, 6.5) + seg(11, 5.5) +
      pathEl('M-2 5l-7 8M4 6l2 9M10 5l9 7', line('wood_deep', SW_H)) +
      pathEl('M-14 -4l-8-8M-14 -4l-2-10', line('wood_deep', SW_H));
  },

  // A rounded, stacked skep beehive — overlapping ellipses narrowing toward
  // the top (not rounded rects, which read as blocks, not a dome), a dark
  // entrance hole near the base.
  hive: (o) => {
    const w = o.w || 110;
    const layer = (cy, lw, lh) => ellipse(0, n(cy), n(lw / 2), n(lh / 2), solid('sand', 'sand_deep', SW_D));
    return layer(-16, w, 46) + layer(-54, w * 0.82, 42) + layer(-90, w * 0.62, 38) + layer(-120, w * 0.4, 30) +
      ellipse(0, -8, n(w * 0.12), 9, { fill: c('ink'), opacity: 0.5, stroke: 'none' });
  },

  // A pie in its dish — crimped crust rim, domed top; o.cut shows a wedge
  // of glossy filling in o.fillingKey (default 'plum').
  pie: (o) => {
    const w = o.w || 200, h = o.h || 60, fk = o.fillingKey || 'plum';
    const dish = ellipse(0, 14, n(w / 2 + 10), 18, solid('metal', 'metal_deep', SW_D));
    const crust = pathEl(`M${n(-w / 2)} 6a${n(w / 2)} ${n(h)} 0 0 1 ${n(w)} 0z`, solid('wood', 'wood_deep', SW_D)) +
      // two short crust-slit marks on top — a pie's own signature, so it
      // doesn't read as a plain mound (see `dune`).
      pathEl(`M${n(-w * 0.14)} ${n(6 - h * 0.74)}l-10 18M${n(w * 0.14)} ${n(6 - h * 0.74)}l10 18`, line('wood_deep', SW_H));
    let crimps = '';
    for (let i = 0; i <= 8; i++) {
      const x = -w / 2 + (w / 8) * i;
      crimps += circle(n(x), 6, 6, solid('wood', 'wood_deep', SW_H));
    }
    if (o.cut) {
      return dish + crimps + crust +
        ellipse(0, n(6 - h * 0.55), n(w * 0.22), n(h * 0.5), solid(fk, `${fk}_deep`, SW_H)) +
        ellipse(n(-w * 0.04), n(6 - h * 0.7), n(w * 0.08), n(h * 0.18), { fill: c('white'), opacity: 0.4, stroke: 'none' });
    }
    return dish + crimps + crust;
  },

  // A small ribbon bow tie — two triangular wings and a centre knot.
  bow_tie: (o) => pathEl('M-22 0L-2 -12L-2 12z', solid('red', 'red_deep', SW_H)) +
    pathEl('M22 0L2 -12L2 12z', solid('red', 'red_deep', SW_H)) +
    circle(0, 0, 6, solid('red', 'red_deep', SW_H)),

  // A crab — body, one raised claw and one resting claw, small legs each
  // side, eyes on stalks.
  crab: (o) => {
    const legAt = (x, flip) => pathEl(`M${n(x)} -6q${n(flip ? 14 : -14)} 10 ${n(flip ? 10 : -10)} 20`, line('brick_deep', SW_D));
    return legAt(-28, false) + legAt(-14, false) + legAt(14, true) + legAt(28, true) +
      ellipse(0, -14, 40, 24, solid('brick', 'brick_deep', SW_D)) +
      pathEl('M-34 -20q-20 -4 -28-22q10 2 16 10q-2 -10 4-16q8 10 8 28z', solid('brick', 'brick_deep', SW_H)) +
      pathEl('M32 -22q22 -14 38-2q-10 0 -16 6q10 2 12 10q-18 2 -34-14z', solid('brick', 'brick_deep', SW_H)) +
      pathEl('M-14 -34l-4-10M-6 -36l0-10', line('brick_deep', SW_H)) +
      circle(-14, -46, 3.4, { fill: c('ink'), stroke: 'none' }) +
      circle(-6, -48, 3.4, { fill: c('ink'), stroke: 'none' });
  },

  // A rounded mound of sand — a dune, for "the top of a dune" compositions.
  dune: (o) => {
    const w = o.w || 260, h = o.h || 90;
    return pathEl(`M${n(-w / 2)} 4q${n(w * 0.1)} ${n(-h)} ${n(w * 0.5)} ${n(-h)}t${n(w * 0.5)} ${n(h)}z`, solid('earth', 'earth_deep', SW_D)) +
      pathEl(`M${n(-w * 0.2)} ${n(-h * 0.7)}q10 -6 20 0M${n(w * 0.1)} ${n(-h * 0.5)}q10 -6 20 0`, line('grass_deep', SW_H));
  },

  // A triangular wrapped sandwich — bread wedge, a filling stripe, a
  // wrapper fold line along the bottom.
  sandwich: (o) => {
    const w = o.w || 70, h = o.h || 60;
    return pathEl(`M${n(-w / 2)} 0H${n(w / 2)}L0 ${n(-h)}z`, solid('sand', 'sand_deep', SW_D)) +
      rrect(n(-w * 0.38), n(-h * 0.4), n(w * 0.76), 10, 4, { fill: c('leafy'), stroke: 'none' }) +
      pathEl(`M${n(-w / 2)} 0q${n(w * 0.15)} 10 ${n(w * 0.5)} 10t${n(w * 0.5)} -10`, line('white_deep', SW_H));
  },

  // A small cup on a saucer, with two rising steam curls.
  teacup: (o) => {
    const w = o.w || 44, h = w * 0.55;
    return ellipse(0, 4, n(w * 0.62), 8, solid('white', 'white_deep', SW_H)) +
      rrect(n(-w / 2), n(-h), w, h, R.sm, solid('white', 'white_deep', SW_D)) +
      pathEl(`M${n(w / 2 - 2)} ${n(-h * 0.6)}q14 0 14 14t-14 10`, line('white_deep', SW_H)) +
      pathEl(`M${n(-w * 0.18)} ${n(-h - 6)}q-6 -14 0-22M${n(w * 0.1)} ${n(-h - 6)}q-6 -14 0-22`,
        { fill: 'none', stroke: c('white_deep'), 'stroke-width': SW_H, opacity: 0.6 });
  },

  // An open storybook, propped up — two wide flat pages meeting at a
  // spine, with a couple of hairline "text block" rules per page (never
  // letters) so it doesn't read as a plain chevron.
  book_prop: (o) => {
    const w = o.w || 96, h = o.h || 50;
    const page = (sx) => pathEl(`M0 0L${n(sx * w / 2)} ${n(-h * 0.75)}L${n(sx * w / 2)} ${n(-h)}L0 ${n(-h * 0.3)}z`,
      solid('water', 'water_deep', SW_D));
    const rules = (sx) => [0.45, 0.6, 0.75].map((f) =>
      pathEl(`M${n(sx * w * 0.12)} ${n(-h * f)}L${n(sx * w * 0.42)} ${n(-h * (f - 0.05))}`, line('water_deep', SW_H))).join('');
    return page(-1) + page(1) + rules(-1) + rules(1) + pathEl(`M0 0V${n(-h * 0.3)}`, line('water_deep', SW_H));
  },

  // A small cresting wave — a curling lip of water with a foam highlight,
  // for close shoreline pages (front layer).
  // Fixed b383 — the foam highlight stroked plain 'white' directly, which
  // fails WCAG 3:1 against both the sky and earth grounds the first scene to
  // actually use this prop (by-the-sea) paints behind it. Every other
  // highlight in the kit uses 'white_deep' as its outline tone for exactly
  // this reason (see cloud, moon); this one had just never been rendered
  // before, so check-illustrations.js never saw it.
  wave: (o) => pathEl('M-50 10q10-26 50-26t50 26q-20-10-50-10t-50 10z', solid('water', 'water_deep', SW_D)) +
    pathEl('M-30 -10q20-10 60 0', { fill: 'none', stroke: c('white_deep'), 'stroke-width': SW_H, opacity: 0.8 }),

  /* -------------------------------------------------------------------------
   * Added b384 — props for books 25-32 (PROPS.md updated to match). Every
   * creature/object below follows the same rule the b382/b383 reviews
   * established: the 2-3 features a child actually names it by, built like
   * the cast (bold outline, one eye, flat fill), never an ellipse with
   * details stuck on.
   * ---------------------------------------------------------------------- */

  // A simple friendly child — same construction as `stallholder` (bold
  // outline, one eye, flat fill) but child-proportioned, with a few named
  // poses. o.skin/o.hair/o.shirt pick the tones (reusable for any later
  // "a boy"/"a child" brief with different colours — varied skin tones
  // across the scheme).
  // The torso and head are sized so the head's own circle OVERLAPS the
  // torso's top edge by several units in every pose — drawn separately but
  // never leaving a gap between them (a first attempt here briefly floated
  // the head above an unconnected lap/torso shape).
  child: (o) => {
    const skin = o.skin || 'earth', hair = o.hair || 'wood', shirt = o.shirt || 'petal';
    // o.skinStroke (b392): lets a caller pair a deep skin fill (e.g.
    // 'wood_deep') with an 'ink' stroke instead of a nonexistent doubled
    // '_deep' token — see helper_person's identical fix for why.
    const skinStroke = o.skinStroke || `${skin}_deep`;
    const hairCap = (hx, hy, r) => pathEl(
      `M${n(hx - r)} ${n(hy)}Q${n(hx - r)} ${n(hy - r * 1.4)} ${n(hx)} ${n(hy - r * 1.4)}` +
      `Q${n(hx + r)} ${n(hy - r * 1.4)} ${n(hx + r)} ${n(hy)}` +
      `Q${n(hx + r * 0.55)} ${n(hy - r * 0.3)} ${n(hx)} ${n(hy - r * 0.25)}` +
      `Q${n(hx - r * 0.55)} ${n(hy - r * 0.3)} ${n(hx - r)} ${n(hy)}Z`,
      solid(hair, `${hair}_deep`, SW_H));
    if (o.pose === 'sit') {
      const hx = 0, hy = -102;
      return ellipse(0, -6, 56, 22, solid(shirt, `${shirt}_deep`, SW_D)) +
        rrect(-30, -88, 60, 66, R.md, solid(shirt, `${shirt}_deep`, SW_D)) +
        circle(hx, hy, 26, solid(skin, skinStroke, SW_D)) +
        hairCap(hx, hy, 26) +
        eye(n(hx + 6), n(hy - 2), 'open', 0.9, skin);
    }
    // 'stand' (default) | 'wave' | 'laugh'
    const hx = 0, hy = -116;
    const armWave = o.pose === 'wave'
      ? 'M22 -84q6 26 26 30'
      : 'M22 -84q14 8 14 26';
    return rrect(-24, -94, 48, 94, R.md, solid(shirt, `${shirt}_deep`, SW_D)) +
      pathEl('M-22 -84q-14 8-14 26', { fill: 'none', stroke: c(`${shirt}_deep`), 'stroke-width': SW }) +
      pathEl(armWave, { fill: 'none', stroke: c(`${shirt}_deep`), 'stroke-width': SW }) +
      circle(hx, hy, 28, solid(skin, skinStroke, SW_D)) +
      hairCap(hx, hy, 28) +
      eye(n(hx + 6), n(hy - 2), o.pose === 'laugh' || o.pose === 'wave' ? 'happy' : 'open', 0.85, skin);
  },

  // A plain tree-branch stub — a thick rounded double-stroke (the same
  // declared pipe_outer/pipe_inner fill-stroke widths the tap already uses,
  // not a new weight), for a character to cling to without drawing a whole
  // tree. Reusable anywhere a page needs "on a branch" without the oak canopy.
  branch: (o) => {
    const len = o.len || 150;
    return pathEl(`M${n(-len / 2)} 4q${n(len * 0.5)} -10 ${n(len)} 0`, { fill: 'none', stroke: c('wood_deep'), 'stroke-width': 17, 'stroke-linecap': 'round' }) +
      pathEl(`M${n(-len / 2)} 4q${n(len * 0.5)} -10 ${n(len)} 0`, { fill: 'none', stroke: c('wood'), 'stroke-width': 10, 'stroke-linecap': 'round' });
  },

  // A washing line strung between two posts, three pieces of laundry
  // flapping sideways — the lean baked into each flag's own path (props
  // can't rotate), same convention as `light_shaft`. For 27-fun-in-the-wind.
  washing_line: (o) => {
    const w = o.w || 260, sag = o.sag || 16;
    const cols = ['water', 'petal', 'sky'];
    let m = rrect(n(-w / 2 - 7), -140, 14, 140, R.sm, solid('wood', 'wood_deep', SW_H)) +
      rrect(n(w / 2 - 7), -152, 14, 152, R.sm, solid('wood', 'wood_deep', SW_H)) +
      pathEl(`M${n(-w / 2)} -136Q0 ${n(-136 + sag)} ${n(w / 2)} -146`, line('wood_deep', SW_H));
    [-0.32, 0.02, 0.34].forEach((t, i) => {
      const x = w * t, col = cols[i % cols.length], y = -136 + Math.abs(t) * 10;
      m += pathEl(`M${n(x - 20)} ${n(y)}q${n(16)} 18 ${n(42)} 4q6 20-8 30q-32 6-38-20q-4-8 4-14z`, solid(col, `${col}_deep`, SW_H));
    });
    return m;
  },

  // A few wind-flattened grass blades, leaning one direction — distinct
  // from the upright `grass_tuft`.
  grass_flat: (o) => {
    const w = o.w || 120;
    return [-0.4, -0.1, 0.22, 0.48].map((t) => {
      const x = w * t;
      return pathEl(`M${n(x)} 0q${n(18)} -4 ${n(34)} -11`, line('grass_deep', SW_D));
    }).join('');
  },

  // A small terracotta flowerpot with one chipped rim nick.
  flowerpot: (o) => {
    const w = o.w || 60, h = o.h || 50;
    return pathEl(`M${n(-w / 2)} 0h${n(w)}l-6 ${n(-h)}h${n(-(w - 12))}z`, solid('brick', 'brick_deep', SW_D)) +
      rrect(n(-w / 2 - 4), n(-h - 10), n(w + 8), 14, R.sm, solid('brick', 'brick_deep', SW_H)) +
      pathEl(`M${n(w / 2 - 12)} ${n(-h + 8)}l8 10-12 2z`, { fill: c('paper'), stroke: 'none' });
  },

  // A small framed window — a plain sky pane, o.windy adds a couple of
  // faint motion hairlines visible through the glass (wind seen from
  // indoors, 27-fun-in-the-wind's shed interior).
  window: (o) => {
    const w = o.w || 70, h = o.h || 90;
    return rrect(n(-w / 2 - 6), n(-h - 6), n(w + 12), n(h + 12), R.sm, solid('wood', 'wood_deep', SW_D)) +
      rrect(n(-w / 2), -h, w, h, R.sm, solid('sky', 'wood_deep', SW_H)) +
      (o.windy ? pathEl(`M${n(-w / 2 + 6)} ${n(-h * 0.68)}q${n(w * 0.3)} -6 ${n(w - 12)} 0M${n(-w / 2 + 6)} ${n(-h * 0.36)}q${n(w * 0.3)} -6 ${n(w - 12)} 0`,
          { fill: 'none', stroke: c('white_deep'), 'stroke-width': SW_H, opacity: 0.6 }) : '') +
      pathEl(`M0 ${n(-h)}V0`, line('wood_deep', SW_H));
  },

  // A checked picnic cloth laid on the ground — alternating squares, never
  // a solid colour alone (meaning-never-by-colour-alone extends to props
  // too: the checks are drawn, not implied).
  picnic_cloth: (o) => {
    const w = o.w || 220, h = o.h || 90, cols = 6, rows = 3;
    let m = rrect(n(-w / 2), n(-h / 2), w, h, R.sm, solid('paper', 'earth_deep', SW_D));
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if ((i + j) % 2 === 0) continue;
        m += rrect(n(-w / 2 + i * (w / cols)), n(-h / 2 + j * (h / rows)), n(w / cols), n(h / rows), 0,
          { fill: c('red'), opacity: 0.55, stroke: 'none' });
      }
    }
    return m;
  },

  // A single potato crisp — a wavy-edged disc, held or on the ground.
  crisp: () => pathEl('M-30 6q-8-24 8-36q22-14 42 0q18 14 10 36q-10 18-32 16q-18-2-28-16z', solid('sun', 'sun_deep', SW_D)) +
    pathEl('M-16 -14q14-10 30 2', line('sun_deep', SW_H)) +
    pathEl('M-8 8q12 8 26-2', line('sun_deep', SW_H)),

  // A round purple plum — distinct from the teardrop `fig_fruit`.
  plum_fruit: () => circle(0, 0, 24, solid('plum', 'plum_deep', SW_D)) +
    pathEl('M0 -24v-9', line('leafy_deep', SW_H)) +
    ellipse(-8, -9, 7, 5, { fill: c('white'), opacity: 0.4, stroke: 'none' }),

  // A wasp — deliberately narrower and more pointed than Nell so it is
  // never confusable with the cast bee: a tapered almond body, thin black
  // bands, a dark pointed stinger tip, and small narrow wings (Nell's are
  // big and round). For 28-lunch-on-the-grass.
  wasp: () => pathEl('M-34 0Q-30 -15 -2 -15Q30 -15 34 0Q30 15 -2 15Q-30 15 -34 0Z', solid('sun', 'sun_deep', SW_D)) +
    pathEl('M-14 -14V14M0 -15V15M14 -13V13', line('ink', SW_H)) +
    pathEl('M32 -4L44 0L32 4Z', { fill: c('ink'), stroke: 'none' }) +
    pathEl('M-8 -14q-6-18 10-22q8 14-10 22z', { fill: c('white'), 'fill-opacity': 0.7, stroke: c('ink'), 'stroke-width': SW_H }) +
    pathEl('M4 -15q6-18 22-16q2 16-22 16z', { fill: c('white'), 'fill-opacity': 0.7, stroke: c('ink'), 'stroke-width': SW_H }) +
    eye(-30, -2, 'open', 0.5, 'sun'),

  // A small brimmed sun hat, laid down low (over a sleeping face).
  sun_hat: () => pathEl('M-34 0q34-15 68 0q-6-9-34-9t-34 9z', solid('sun', 'sun_deep', SW_H)) +
    pathEl('M-15 -6q15-11 30 0q-2-15-15-15t-15 15z', solid('sun', 'sun_deep', SW_D)),

  // A single large paw print pressed into mud — four oval toe pads and one
  // bigger heel pad, deliberately NOT the three-toe bird `footprint`.
  paw_print: (o) => {
    const s = o.s || 1;
    return ellipse(0, n(10 * s), n(16 * s), n(12 * s), { fill: c('earth_deep'), opacity: 0.55, stroke: 'none' }) +
      [[-15, -15], [-5, -21], [7, -21], [18, -14]].map(([x, y]) =>
        ellipse(n(x * s), n(y * s), n(8 * s), n(10 * s), { fill: c('earth_deep'), opacity: 0.55, stroke: 'none' })).join('');
  },

  // A single curved claw, gleaming — one safe-contrast outline stroke (never
  // the light 'metal' tone as a stroke; only its own _deep clears every
  // ground) plus a small white-opacity FILL for the gleam, no fill on the
  // claw itself so it reads as a sharp sliver.
  claw: () => pathEl('M0 12Q-5 -14 16 -28', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' }) +
    ellipse(6, -8, 3, 6, { fill: c('white'), opacity: 0.6, stroke: 'none' }),

  // A tabby cat, lying in the sun or mid-yawn. o.pose: 'lying' (default) |
  // 'yawn'. Built the same way as the dog/fox/cow redraws: a real head
  // (not a circle stuck on a blob), pointed ears, whiskers, a curled tail.
  cat: (o) => {
    const stripe = (x, y, w) => pathEl(`M${n(x)} ${n(y)}q${n(w * 0.5)} -7 ${n(w)} 0`, line('earth_deep', SW_H));
    const ears = (hx, hy) => pathEl(`M${n(hx - 18)} ${n(hy - 20)}l-7-16 15 7zM${n(hx + 12)} ${n(hy - 22)}l9-14 7 17z`, solid('earth', 'earth_deep', SW_D));
    const whiskers = (hx, hy) => pathEl(
      `M${n(hx - 16)} ${n(hy + 4)}l-16-2M${n(hx - 16)} ${n(hy + 9)}l-18 4M${n(hx + 24)} ${n(hy + 4)}l16-2M${n(hx + 24)} ${n(hy + 9)}l18 4`,
      line('ink', SW_H));
    if (o.pose === 'yawn') {
      const hx = 58, hy = -56;
      return ellipse(-14, -28, 72, 30, solid('earth', 'earth_deep', SW_D)) +
        stripe(-66, -36, 38) + stripe(-54, -18, 44) +
        circle(hx, hy, 30, solid('earth', 'earth_deep', SW_D)) +
        ears(hx, hy) +
        pathEl(`M${n(hx - 8)} ${n(hy + 8)}q2 28 20 28q18 0 20-22q-18 16-40-6z`, solid('red', 'red_deep', SW_D)) +
        ellipse(n(hx + 10), n(hy + 24), 9, 7, { fill: c('red_deep'), opacity: 0.6, stroke: 'none' }) +
        whiskers(hx, hy) +
        eye(n(hx - 4), n(hy - 8), 'happy', 0.75, 'earth');
    }
    // 'lying' (default)
    const hx = 72, hy = -40;
    return ellipse(-20, -16, 78, 20, solid('earth', 'earth_deep', SW_D)) +
      pathEl('M-92 -16q-20 10-8 26q16-2 20-18z', solid('earth', 'earth_deep', SW_H)) +
      stripe(-72, -24, 36) + stripe(-52, -10, 40) +
      circle(hx, hy, 26, solid('earth', 'earth_deep', SW_D)) +
      ears(hx, hy) +
      whiskers(hx, hy) +
      eye(n(hx - 2), n(hy - 4), 'sleepy', 0.75, 'earth');
  },

  // A big two-handled stew pot. o.empty shows it clean and scraped (metal
  // interior) instead of full (a warm stew-coloured surface).
  stew_pot: (o) => {
    const w = o.w || 180, h = o.h || 110, empty = !!o.empty;
    return ellipse(n(-w * 0.46), n(-h * 0.5), 14, 20, solid('metal', 'metal_deep', SW_D)) +
      ellipse(n(w * 0.46), n(-h * 0.5), 14, 20, solid('metal', 'metal_deep', SW_D)) +
      pathEl(`M${n(-w / 2)} ${n(-h * 0.3)}Q${n(-w / 2)} 0 0 0Q${n(w / 2)} 0 ${n(w / 2)} ${n(-h * 0.3)}z`, solid('metal', 'metal_deep', SW_D)) +
      ellipse(0, n(-h * 0.3), n(w / 2), 16, empty ? solid('metal', 'metal_deep', SW_D) : solid('wood', 'wood_deep', SW_D));
  },

  // A couple of rising steam curls — reusable over any hot food/drink prop.
  steam: (o) => {
    const count = o.n || 2, gap = o.gap || 20;
    let m = '';
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * gap;
      m += pathEl(`M${n(x)} 0q-10 -14 0-22q10 -14 0-22`, { fill: 'none', stroke: c('white_deep'), 'stroke-width': SW_H, opacity: 0.6 });
    }
    return m;
  },

  // A small wooden spoon, held or resting in a pot.
  spoon: () => pathEl('M0 0V-36', line('wood_deep', SW)) +
    ellipse(0, 10, 16, 11, solid('metal', 'metal_deep', SW_D)) +
    ellipse(0, 8, 10, 6, solid('wood', 'wood_deep', SW_H)),

  // One round pea — placed several times, "exactly a few, drawn countably".
  pea: () => circle(0, 0, 7, solid('leafy', 'leafy_deep', SW_H)),

  // A simple bowl with a stew-coloured surface.
  bowl: (o) => {
    const w = o.w || 90;
    return pathEl(`M${n(-w / 2)} 0q${n(w * 0.04)} ${n(w * 0.34)} ${n(w * 0.46)} ${n(w * 0.34)}q${n(w * 0.42)} 0 ${n(w * 0.46)} ${n(-w * 0.34)}z`,
      solid('metal', 'metal_deep', SW_D)) +
      ellipse(0, 0, n(w * 0.44), n(w * 0.12), solid('wood', 'wood_deep', SW_H));
  },

  // A garden hoe — a long handle, a short angled neck, and a flat blade
  // near the ground. Redrawn during the b384 contact-sheet review: the
  // first version (a straight post with a rounded rect on top) read as a
  // street sign. A tool needs its blade low, flat and at an angle, not a
  // plaque mounted high on a post.
  hoe: (o) => {
    const len = o.len || 160;
    return pathEl(`M2 ${n(-len)}L12 -26`, { fill: 'none', stroke: c('wood_deep'), 'stroke-width': SW, 'stroke-linecap': 'round' }) +
      pathEl('M12 -26L24 -6', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' }) +
      pathEl('M-26 0L8 -20L38 -6L6 16Z', solid('metal', 'metal_deep', SW_D));
  },

  // A single dug furrow — a groove with a raised ridge each side, for a
  // hoed bed rather than the whole dug `vegetable_patch`.
  furrow: (o) => {
    const w = o.w || 160;
    return pathEl(`M${n(-w / 2)} 4Q0 -7 ${n(w / 2)} 4`, { fill: 'none', stroke: c('earth_deep'), 'stroke-width': SW_D }) +
      pathEl(`M${n(-w / 2)} -2Q0 -11 ${n(w / 2)} -2`, line('earth_deep', SW_H));
  },

  // A doe, running — stretched body, raised neck and head, pointed ears,
  // four BENT, asymmetric legs (two stretched ahead, two stretched behind)
  // for a mid-gallop silhouette. o.col (default 'earth') lets a distant/
  // silhouette page darken it.
  // Redrawn during the b384 contact-sheet review: the first version used
  // four thin, symmetric, dead-straight hairline legs, which read as a
  // static generic four-legged animal rather than a deer mid-leap. Legs are
  // now bent at a knee and drawn as a bold stroke (the same declared
  // pipe_inner fill-stroke width the tap/branch already use, not a new
  // weight) so the gait and the silhouette both read at a glance.
  deer: (o) => {
    const col = o.col || 'earth', deep = `${col}_deep`;
    // A leg is a FILLED angled sliver (hip -> foot), not a thin stroke —
    // this is the second redraw during the b384 contact-sheet review. The
    // first redraw (bent hairline strokes) still read as a generic
    // spindly-legged animal at thumbnail size; a solid filled leg with a
    // small hoof reads far more clearly, the same lesson the b382 goat/cow
    // redraws already established.
    const leg = (hx, hy, fx, fy, w) => {
      const dx = fx - hx, dy = fy - hy, len = Math.sqrt(dx * dx + dy * dy);
      const px = (-dy / len) * (w / 2), py = (dx / len) * (w / 2);
      return pathEl(`M${n(hx + px)} ${n(hy + py)}L${n(fx + px)} ${n(fy + py)}L${n(fx - px)} ${n(fy - py)}L${n(hx - px)} ${n(hy - py)}Z`,
        solid(col, deep, SW_H)) +
        ellipse(n(fx), n(fy + 2), 6, 4, { fill: c(deep), stroke: 'none' });
    };
    const hx = 68, hy = -100;
    // A slim, elongated body (not the round pig/cow barrel) and a FILLED
    // rising neck wedge connecting it to the head, so the head never floats.
    const body = ellipse(-8, -56, 44, 19, solid(col, deep, SW_D));
    const neck = pathEl(`M${n(hx - 30)} ${n(hy + 38)}Q${n(hx - 34)} ${n(hy + 4)} ${n(hx - 8)} ${n(hy - 2)}` +
      `L${n(hx + 10)} ${n(hy + 18)}Q${n(hx - 8)} ${n(hy + 30)} ${n(hx - 30)} ${n(hy + 38)}Z`, solid(col, deep, SW_D));
    const head = circle(hx, hy, 16, solid(col, deep, SW_D));
    const ears = pathEl(`M${n(hx - 8)} ${n(hy - 13)}l-6-17 11 9zM${n(hx + 7)} ${n(hy - 13)}l7-16 7 13z`, solid(col, deep, SW_H));
    const tail = pathEl('M-50 -62q-9 8-2 18', line(deep, SW_H));
    return body +
      leg(-26, -44, -56, 2, 11) +
      leg(-10, -40, -18, 10, 11) +
      leg(14, -40, 24, 10, 11) +
      leg(26, -44, 56, -2, 11) +
      neck + head + ears + tail +
      eye(n(hx + 5), n(hy - 1), 'open', 0.45, col);
  },

  // A hauling net on a rope — bigger than the handheld `fishing_net`.
  // o.state: 'taut' (default, a rope down to a visible snagged net BAG with
  // mesh texture and a rim hoop) | 'landed' (the net open on the bank,
  // bulging). Redrawn during the b384 contact-sheet review: the first
  // 'taut' version was only a thin rope and a tiny underwater arc — at
  // thumbnail size it read as "a stick in a pond", not a net at all. The
  // bag must be big and solid enough to read as netting on its own.
  haul_net: (o) => {
    const state = o.state || 'taut';
    if (state === 'landed') {
      const w = o.w || 180, h = o.h || 70;
      let m = pathEl(`M${n(-w / 2)} 0Q${n(-w / 2)} ${n(-h)} 0 ${n(-h)}Q${n(w / 2)} ${n(-h)} ${n(w / 2)} 0z`,
        solid('metal', 'metal_deep', SW_D));
      for (let i = 1; i < 5; i++) {
        const x = -w / 2 + (w / 5) * i;
        m += pathEl(`M${n(x)} 0V${n(-h * 0.88)}`, line('metal_deep', SW_H));
      }
      [0.3, 0.55, 0.76].forEach((f) => { m += pathEl(`M${n(-w / 2)} ${n(-h * f)}Q0 ${n(-h * f - 9)} ${n(w / 2)} ${n(-h * f)}`, line('metal_deep', SW_H)); });
      return m;
    }
    const len = o.len || 170, sx = o.snagX != null ? o.snagX : len * 0.1;
    const bagW = 72, bagH = 60, by = len - bagH * 0.5;
    const rope = pathEl(`M0 0L${n(sx)} ${n(by - bagH * 0.5 - 10)}`, { fill: 'none', stroke: c('wood_deep'), 'stroke-width': SW });
    const rim = pathEl(`M${n(sx - bagW / 2 - 6)} ${n(by - bagH * 0.5)}Q${n(sx)} ${n(by - bagH * 0.5 - 16)} ${n(sx + bagW / 2 + 6)} ${n(by - bagH * 0.5)}`,
      { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
    const bag = pathEl(`M${n(sx - bagW / 2)} ${n(by - bagH * 0.5)}Q${n(sx - bagW / 2 - 10)} ${n(by + bagH * 0.3)} ${n(sx)} ${n(by + bagH * 0.6)}` +
      `Q${n(sx + bagW / 2 + 10)} ${n(by + bagH * 0.3)} ${n(sx + bagW / 2)} ${n(by - bagH * 0.5)}Z`,
      solid('metal', 'metal_deep', SW_D));
    let mesh = '';
    for (let i = -2; i <= 2; i++) {
      const x0 = sx + i * 13;
      mesh += pathEl(`M${n(x0)} ${n(by - bagH * 0.46)}L${n(x0 + 16)} ${n(by + bagH * 0.34)}`, line('metal_deep', SW_H));
      mesh += pathEl(`M${n(x0)} ${n(by - bagH * 0.46)}L${n(x0 - 16)} ${n(by + bagH * 0.34)}`, line('metal_deep', SW_H));
    }
    return rope + bag + mesh + rim;
  },

  // A looping dashed swoosh — a motion arc for a somersault/vault, same
  // "draw the effect, not a symbol" convention as ripples/frost/wind_lines.
  motion_arc: (o) => {
    const r = o.r || 50;
    return pathEl(`M${n(-r)} 0A${r} ${r} 0 1 1 ${n(r)} 0`,
      { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H, opacity: 0.45, 'stroke-dasharray': '3 11' });
  },

  /* -------------------------------------------------------------------------
   * Added b385 — props for books 33-43 (PROPS.md updated to match). Same
   * rule as every batch since b382: the 2-3 features a child names it by,
   * built like the cast (bold outline, one eye where it has a face, flat
   * fill), never an ellipse with details stuck on.
   * ---------------------------------------------------------------------- */

  // A single-panel wooden garden gate on a post, swinging on a visible rusty
  // hinge (a worn metal disc with a bright paint-chip nick) — distinct from
  // the wide horizontal-rail `farm_gate`. For 33-pips-listening-walk.
  garden_gate: (o) => {
    const w = o.w || 86, h = o.h || 112;
    const post = rrect(n(-w / 2 - 11), n(-h - 16), 15, n(h + 16), R.sm, solid('wood', 'wood_deep', SW_D));
    const panel = rrect(n(-w / 2), n(-h), w, h, R.sm, solid('wood', 'wood_deep', SW_D));
    const slats = [0.24, 0.52, 0.8].map((f) => pathEl(`M${n(-w / 2 + 5)} ${n(-h + h * f)}h${n(w - 10)}`, line('wood_deep', SW_H))).join('');
    const brace = pathEl(`M${n(-w / 2 + 5)} -5L${n(w / 2 - 5)} ${n(-h + 5)}`, line('wood_deep', SW_H));
    const hinge = (hy) => circle(n(-w / 2 - 3), n(hy), 9, solid('metal', 'metal_deep', SW_H)) +
      ellipse(n(-w / 2 - 6), n(hy - 3), 3, 2, { fill: c('white'), opacity: 0.65, stroke: 'none' });
    return post + panel + slats + brace + hinge(n(-h * 0.2)) + hinge(n(-h * 0.72));
  },

  // A small empty glass jam jar — a held conductor's-baton prop, not a food
  // item. For 34-nells-noisy-hive.
  jam_jar: (o) => {
    const w = o.w || 40, h = o.h || 54;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, { fill: c('sky'), opacity: 0.32, stroke: c('metal_deep'), 'stroke-width': SW_D }) +
      rrect(n(-w / 2 - 3), n(-h - 9), n(w + 6), 11, R.sm, solid('metal', 'metal_deep', SW_H)) +
      ellipse(n(-w * 0.18), n(-h * 0.6), n(w * 0.14), n(h * 0.22), { fill: c('white'), opacity: 0.4, stroke: 'none' });
  },

  // A frog, sitting side-on — two bulging eyes raised clear of a rounded
  // body (the single biggest "frog, not a blob" cue), bent back legs, a wide
  // closed-mouth curve. For 35-moss-and-the-rhyme-pot, 37-the-longest-day.
  frog: (o) => {
    const w = o.w || 72, h = o.h || 42, flip = !!o.flip, s = flip ? -1 : 1;
    const legBack = (x) => pathEl(`M${n(x)} ${n(-h * 0.3)}q${n(s * 16)} 4 ${n(s * 20)} 18q${n(s * -4)} 8 ${n(s * -14)} 6`, solid('leafy', 'leafy_deep', SW));
    const legFront = (x) => pathEl(`M${n(x)} ${n(-h * 0.2)}q${n(s * 9)} 9 ${n(s * 5)} 18`, line('leafy_deep', SW_D));
    return legBack(n(-w * 0.3 * s)) + legBack(n(w * 0.06 * s)) +
      ellipse(0, n(-h * 0.5), n(w * 0.46), n(h * 0.5), solid('leafy', 'leafy_deep', SW_D)) +
      legFront(n(-w * 0.32 * s)) + legFront(n(w * 0.2 * s)) +
      circle(n(-w * 0.14), n(-h * 0.92), 11, solid('leafy', 'leafy_deep', SW_D)) +
      circle(n(w * 0.1), n(-h * 0.92), 11, solid('leafy', 'leafy_deep', SW_D)) +
      eye(n(-w * 0.14), n(-h * 0.92), 'open', 0.68, 'leafy') +
      eye(n(w * 0.1), n(-h * 0.92), 'open', 0.68, 'leafy') +
      pathEl(`M${n(-w * 0.2)} ${n(-h * 0.42)}q${n(w * 0.2)} 9 ${n(w * 0.4)} 0`, line('leafy_deep', SW_H));
  },

  // A small paper picture-card with a drawn icon — never a letter or word.
  // o.icon: 'cat' (default/only icon so far — add more the same way).
  // For 35-moss-and-the-rhyme-pot ("a drawn picture-card of a cat").
  picture_card: (o) => {
    const w = o.w || 50, h = o.h || 60;
    const card = rrect(n(-w / 2), n(-h), w, h, R.sm, solid('paper', 'ink', SW_D));
    if (o.icon === 'cat') {
      const cx = 0, cy = n(-h * 0.52);
      const ears = pathEl(`M${n(cx - 14)} ${n(cy - 10)}l-5-13 12 6zM${n(cx + 14)} ${n(cy - 10)}l5-13 -12 6z`, solid('earth', 'earth_deep', SW_H));
      const head = circle(cx, cy, 15, solid('earth', 'earth_deep', SW_D));
      const whiskers = pathEl(`M${n(cx - 13)} ${n(cy + 3)}l-10-1M${n(cx - 13)} ${n(cy + 6)}l-11 3M${n(cx + 13)} ${n(cy + 3)}l10-1M${n(cx + 13)} ${n(cy + 6)}l11 3`, line('ink', SW_H));
      return card + ears + head + whiskers + eye(n(cx - 4), n(cy - 2), 'open', 0.45, 'earth');
    }
    return card;
  },

  // A wooden garden bench, side-on — seat plank, two back posts, a top
  // rail, four straight legs. Moss's home is under it. For
  // 35-moss-and-the-rhyme-pot.
  bench: (o) => {
    const w = o.w || 220, legH = o.legH || 30, seatH = 16, backH = 46;
    const leg = (x) => rrect(n(x - 7), n(-legH), 14, legH, R.sm, solid('wood', 'wood_deep', SW_D));
    return leg(n(-w * 0.42)) + leg(n(-w * 0.12)) + leg(n(w * 0.12)) + leg(n(w * 0.42)) +
      rrect(n(-w / 2), n(-legH - seatH), w, seatH, R.sm, solid('wood', 'wood_deep', SW_D)) +
      rrect(n(-w / 2), n(-legH - seatH - backH), 12, backH, R.sm, solid('wood', 'wood_deep', SW_H)) +
      rrect(n(w / 2 - 12), n(-legH - seatH - backH), 12, backH, R.sm, solid('wood', 'wood_deep', SW_H)) +
      rrect(n(-w / 2), n(-legH - seatH - backH - 12), w, 12, R.sm, solid('wood', 'wood_deep', SW_D));
  },

  // A hazelnut-brown acorn — a ridged cap over a rounded nut, a short stalk.
  // Placed loose on the ground, held, or floating apart as an oral-blending
  // piece. For 36-olives-sound-game.
  acorn: (o) => {
    const s = o.s || 1;
    return pathEl(`M${n(-14 * s)} ${n(2 * s)}q${n(-4 * s)} ${n(20 * s)} ${n(14 * s)} ${n(24 * s)}q${n(18 * s)} ${n(-4 * s)} ${n(14 * s)} ${n(-24 * s)}z`,
      solid('wood', 'wood_deep', SW_D)) +
      pathEl(`M${n(-16 * s)} ${n(2 * s)}q${n(16 * s)} ${n(-14 * s)} ${n(32 * s)} 0q${n(-16 * s)} ${n(6 * s)} ${n(-32 * s)} 0z`,
        solid('wood', 'wood_deep', SW_H)) +
      pathEl(`M0 ${n(-14 * s)}v${n(-6 * s)}`, line('wood_deep', SW_H));
  },

  // A single petal, close up — a small teardrop, distinct from the full
  // `flower`. For 36-olives-sound-game's border decoration.
  petal_single: () => pathEl('M0 -20q14 6 14 20q0 14-14 20q-14-6-14-20q0-14 14-20z', solid('petal', 'petal_deep', SW_H)),

  // A single scratch mark in bare earth — a short straight diagonal groove
  // with a small mound of displaced earth at one end. Deliberately NOT any
  // letter shape (a bare diagonal tally reads as "just a mark", never a
  // glyph). For 36-olives-sound-game's closing page.
  scratch_mark: (o) => {
    const len = o.len || 46;
    return pathEl(`M${n(-len / 2)} ${n(len * 0.32)}L${n(len / 2)} ${n(-len * 0.32)}`,
      { fill: 'none', stroke: c('earth_deep'), 'stroke-width': SW, 'stroke-linecap': 'round' }) +
      ellipse(n(len * 0.36), n(-len * 0.28), 7, 4, solid('earth', 'earth_deep', SW_H));
  },

  // A slatted wooden crate — upright (empty, open top) or `o.tipped` (lying
  // on its side, a dark open-end ellipse same convention as the tin's open
  // end). For 40-boxes-and-bushes.
  crate: (o) => {
    if (o.tipped) {
      const tw = o.w || 118, th = o.h || 58;
      return rrect(n(-tw / 2), n(-th), tw, th, R.sm, solid('wood', 'wood_deep', SW_D)) +
        ellipse(n(tw * 0.22), n(-th * 0.5), n(th * 0.42), n(th * 0.36), { fill: c('wood_deep'), opacity: 0.5, stroke: 'none' }) +
        [0.3, 0.6, 0.86].map((f) => pathEl(`M${n(-tw / 2 + tw * f)} ${n(-th + 4)}V-4`, line('wood_deep', SW_H))).join('');
    }
    const w = o.w || 92, h = o.h || 78;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('wood', 'wood_deep', SW_D)) +
      rrect(n(-w / 2 - 4), n(-h - 8), n(w + 8), 14, R.sm, solid('wood', 'wood_deep', SW_H)) +
      [0.32, 0.64].map((f) => pathEl(`M${n(-w / 2 + 6)} ${n(-h + h * f)}h${n(w - 12)}`, line('wood_deep', SW_H))).join('') +
      pathEl(`M${n(-w / 2 + 4)} ${n(-h + 4)}V-4M${n(w / 2 - 4)} ${n(-h + 4)}V-4`, line('wood_deep', SW_H));
  },

  // A shallow white china dish — a rim highlight band and one paint-chip
  // nick (same chip convention as `boat`). For 40-boxes-and-bushes.
  dish: (o) => {
    const w = o.w || 90, h = o.h || 26;
    return ellipse(0, 0, n(w / 2), n(h / 2), solid('white', 'white_deep', SW_D)) +
      ellipse(0, n(-h * 0.14), n(w * 0.36), n(h * 0.3), { fill: c('sky'), opacity: 0.5, stroke: 'none' }) +
      pathEl(`M${n(w * 0.3)} ${n(-h * 0.3)}l8 4-3 7z`, { fill: c('paper'), stroke: 'none' });
  },

  // A small lopsided cake on a leaf plate — the brief asks for a name
  // "spelled out in seeds", which the no-letters-ever rule overrides (see
  // DEPARTURES.md): the seeds are a decorative scatter, not legible text.
  // For 41-the-cake-on-the-lake.
  cake: (o) => {
    const w = o.w || 84, h = o.h || 56;
    // A wide flat leaf, noticeably broader than the cake sitting on it, so
    // "cake on a leaf plate" reads even before the cake itself is parsed.
    const plate = pathEl(`M${n(-w * 0.72)} ${n(h * 0.42)}Q0 ${n(h * 0.66)} ${n(w * 0.72)} ${n(h * 0.42)}Q${n(w * 0.5)} ${n(h * 0.56)} 0 ${n(h * 0.56)}Q${n(-w * 0.5)} ${n(h * 0.56)} ${n(-w * 0.72)} ${n(h * 0.42)}Z`,
      solid('leafy', 'leafy_deep', SW_H));
    // A tall drum-shaped sponge (not a wide squat bun) with a WHITE icing
    // dome — white against the brown sponge is what separates "cake" from
    // "burger bun" at a glance.
    const body = rrect(n(-w * 0.42), n(-h * 0.56), n(w * 0.84), n(h * 0.62), R.sm, solid('wood', 'wood_deep', SW_D));
    const icing = pathEl(`M${n(-w * 0.48)} ${n(-h * 0.5)}q${n(w * 0.1)} ${n(-h * 0.24)} ${n(w * 0.48)} ${n(-h * 0.24)}q${n(w * 0.38)} 0 ${n(w * 0.48)} ${n(h * 0.24)}` +
      `q${n(-w * 0.06)} ${n(h * 0.1)} ${n(-w * 0.48)} ${n(h * 0.1)}q${n(-w * 0.42)} 0 ${n(-w * 0.48)} ${n(-h * 0.1)}z`,
      solid('white', 'white_deep', SW_D));
    const drip = [-0.3, 0, 0.3].map((t) => pathEl(`M${n(w * t)} ${n(-h * 0.5)}q4 ${n(h * 0.12)} 0 ${n(h * 0.2)}`, line('white_deep', SW_H))).join('');
    const seeds = [[-16, -42], [0, -48], [16, -42], [-8, -34], [8, -34]]
      .map(([x, y]) => circle(n(x), n(y), 3, solid('red', 'red_deep', SW_H))).join('');
    return plate + body + icing + drip + seeds;
  },

  // A plain farmyard duck — a non-cast creature, deliberately a different
  // body tone (o.col, default 'white') from Ned's cast gold so the two are
  // never confusable. For 41-the-cake-on-the-lake ("a duck swam up").
  duck: (o) => {
    const col = o.col || 'white', deep = `${col}_deep`;
    return pathEl('M-20 6l-14-4 4 10 12 2z', solid(col, deep, SW_H)) +
      ellipse(6, 10, 34, 22, solid(col, deep, SW_D)) +
      circle(36, -10, 18, solid(col, deep, SW_D)) +
      rrect(50, -14, 20, 11, R.sm, solid('sun', 'sun_deep', SW_H)) +
      eye(42, -14, 'open', 0.6, col);
  },

  // A diamond kite on a string, a ribbon tail. o.col (default 'white') picks
  // the sail colour; o.string gives the string a length (down to that y, in
  // local units) with o.stringDx for the far end's x — pass o.coil for a
  // loose coiled length near a character instead of a taut line; o.muddy
  // adds a faint earth smudge for "came back muddy". For 42-five-white-kites.
  kite: (o) => {
    const w = o.w || 70, h = o.h || 90, col = o.col || 'white';
    const diamond = pathEl(`M0 ${n(-h / 2)}L${n(w / 2)} 0L0 ${n(h / 2)}L${n(-w / 2)} 0Z`, solid(col, `${col}_deep`, SW_D));
    const spine = pathEl(`M0 ${n(-h / 2)}L0 ${n(h / 2)}M${n(-w / 2)} 0L${n(w / 2)} 0`, line(`${col}_deep`, SW_H));
    const tail = pathEl(`M0 ${n(h / 2)}q8 16-6 30q10 2 4 20`, line(`${col}_deep`, SW_H));
    let string = '';
    if (o.string) {
      const len = o.string, dx = o.stringDx || 0;
      string = o.coil
        ? pathEl(`M0 ${n(h / 2)}q14 ${n(len * 0.3)} 0 ${n(len * 0.5)}q-14 ${n(len * 0.2)} 0 ${n(len * 0.5)}q14 ${n(len * 0.15)} ${n(dx)} ${n(len * 0.4)}`, line('wood_deep', SW_H))
        : pathEl(`M0 ${n(h / 2)}L${n(dx)} ${n(len)}`, line('wood_deep', SW_H));
    }
    const mud = o.muddy ? ellipse(0, n(h * 0.1), n(w * 0.3), n(h * 0.14), { fill: c('earth_deep'), opacity: 0.4, stroke: 'none' }) : '';
    return diamond + spine + tail + string + mud;
  },

  // A simple mobile phone — rounded body, a screen pane. o.screen picks what
  // the screen shows: undefined/'off' (a faint dew gleam only), 'ring' (a
  // bright glowing pane), 'blurry' (a soft out-of-focus blob — "Olive's
  // foot filling a blurry screen"), 'child' (reuses `PROPS.child` scaled
  // small inside the pane — the module's props are all in one object, so a
  // later-defined prop can safely call an earlier one by the time either is
  // actually invoked). For 43-the-blue-phone.
  phone: (o) => {
    const w = o.w || 50, h = o.h || 96;
    const body = rrect(n(-w / 2), n(-h), w, h, R.md, solid('water', 'water_deep', SW_D));
    const screenW = w - 10, screenH = h - 20, screenY = n(-h + 10);
    const screenRect = rrect(n(-screenW / 2), screenY, screenW, screenH, R.sm, solid('sky', 'wood_deep', SW_H));
    let content = '';
    if (o.screen === 'ring') {
      content = rrect(n(-screenW / 2), screenY, screenW, screenH, R.sm, { fill: c('sun'), opacity: 0.55, stroke: 'none' });
    } else if (o.screen === 'blurry') {
      content = ellipse(0, n(-h + 10 + screenH * 0.55), n(screenW * 0.3), n(screenH * 0.22), { fill: c('earth'), opacity: 0.5, stroke: 'none' }) +
        ellipse(0, n(-h + 10 + screenH * 0.55), n(screenW * 0.2), n(screenH * 0.13), { fill: c('earth_deep'), opacity: 0.3, stroke: 'none' });
    } else if (o.screen === 'child') {
      content = group(PROPS.child({ pose: 'laugh', skin: o.skin, hair: o.hair, shirt: o.shirt }),
        { transform: `translate(0 ${n(-h + 10 + screenH * 0.96)}) scale(${n(screenH / 150)})` });
    } else {
      content = ellipse(n(-screenW * 0.2), n(-h + 10 + screenH * 0.22), n(screenW * 0.14), n(screenH * 0.1), { fill: c('white'), opacity: 0.35, stroke: 'none' });
    }
    const button = circle(0, -6, 4, solid('metal', 'metal_deep', SW_H));
    return body + screenRect + content + button;
  },

  /* -------------------------------------------------------------------------
   * Added b386 — Wren Printables picture bank. Plain household/CVC objects
   * and a few seasonal/topic objects, drawn as standalone icons (scripts/
   * printables/picture-bank.js composes them on a 'plain' backdrop). Same
   * primitives, same palette tokens, same SW/SW_D/SW_H weights as every prop
   * above — no second drawing style.
   * ---------------------------------------------------------------------- */
  bus: (o) => {
    const w = o.w || 140, h = o.h || 64;
    return rrect(n(-w / 2), n(-h), w, h, R.md, solid('red', 'red_deep', SW_D)) +
      rrect(n(-w / 2 + 10), n(-h + 10), n(w - 20), n(h * 0.42), R.sm, solid('sky', 'metal_deep', SW_H)) +
      [0.3, 0.7].map((f) => pathEl(`M${n(-w / 2 + 10 + (w - 20) * f)} ${n(-h + 10)}V${n(-h + 10 + h * 0.42)}`, line('metal_deep', SW_H))).join('') +
      circle(n(-w * 0.28), 4, 14, solid('metal', 'metal_deep', SW_D)) +
      circle(n(w * 0.28), 4, 14, solid('metal', 'metal_deep', SW_D));
  },

  bag: (o) => {
    const w = o.w || 70, h = o.h || 74;
    return pathEl(`M${n(-w / 2)} 0h${n(w)}l-6 ${n(-h)}h${n(-(w - 12))}z`, solid('brick', 'brick_deep', SW_D)) +
      pathEl(`M${n(-w / 2 + 10)} ${n(-h)}q${n(w / 2 - 10)} -26 ${n(w - 20)} 0`, line('brick_deep', SW_D));
  },

  pan: (o) => {
    const r = o.r || 34;
    return circle(0, 0, r, solid('metal', 'metal_deep', SW_D)) +
      circle(0, 0, n(r * 0.74), { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H, opacity: 0.5 }) +
      rrect(n(r * 0.7), -6, 46, 12, R.sm, solid('wood', 'wood_deep', SW_H));
  },

  pin: (o) => circle(0, -16, 16, solid('red', 'red_deep', SW_D)) +
    pathEl('M-4 -4l4 24 4-24z', solid('metal', 'metal_deep', SW_H)),

  bed: (o) => {
    const w = o.w || 110, h = o.h || 50;
    return rrect(n(-w / 2), n(-h * 0.4), w, n(h * 0.4), R.sm, solid('petal', 'petal_deep', SW_D)) +
      rrect(n(-w / 2 - 6), n(-h), 14, h, R.sm, solid('wood', 'wood_deep', SW_D)) +
      rrect(n(w / 2 - 8), n(-h * 0.75), 14, n(h * 0.75), R.sm, solid('wood', 'wood_deep', SW_D)) +
      ellipse(n(-w / 2 + 22), n(-h * 0.52), 16, 10, solid('white', 'white_deep', SW_H));
  },

  mop: (o) => {
    const len = o.len || 100;
    return pathEl(`M0 0V${n(-len)}`, line('wood_deep', SW)) +
      pathEl('M-16 0q16 14 32 0', solid('sun', 'sun_deep', SW_H)) +
      Array.from({ length: 5 }, (_, i) => pathEl(`M${n(-14 + i * 7)} 0v16`, line('sun_deep', SW_H))).join('');
  },

  pot: (o) => {
    const w = o.w || 90, h = o.h || 56;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('metal', 'metal_deep', SW_D)) +
      rrect(n(-w / 2 - 14), n(-h * 0.7), 14, 10, R.sm, solid('metal', 'metal_deep', SW_H)) +
      rrect(n(w / 2), n(-h * 0.7), 14, 10, R.sm, solid('metal', 'metal_deep', SW_H)) +
      ellipse(0, n(-h), n(w / 2), 8, solid('metal', 'metal_deep', SW_H));
  },

  jug: (o) => {
    const w = o.w || 56, h = o.h || 70;
    return pathEl(`M${n(-w / 2)} 0q-4 ${n(-h * 0.9)} ${n(w * 0.3)} ${n(-h)}h${n(w * 0.4)}q${n(w * 0.3 + 4)} ${n(h * 0.1)} ${n(w * 0.3)} ${n(h)}z`, solid('sky', 'metal_deep', SW_D)) +
      pathEl(`M${n(w / 2 - 4)} ${n(-h * 0.75)}q18 6 0 ${n(h * 0.35)}`, { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D });
  },

  map: (o) => {
    const w = o.w || 90, h = o.h || 70;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('earth', 'earth_deep', SW_D)) +
      pathEl(`M${n(-w / 3)} ${n(-h)}V0M${n(w / 3)} ${n(-h)}V0`, line('earth_deep', SW_H)) +
      pathEl(`M${n(-w / 2 + 10)} ${n(-h * 0.6)}l${n(w * 0.5)} ${n(-h * 0.25)}`, { fill: 'none', stroke: c('red_deep'), 'stroke-width': SW_H, 'stroke-dasharray': '4 4' }) +
      pathEl(`M${n(w / 2 - 14)} ${n(-h * 0.3)}l5-6-7-2z`, solid('red', 'red_deep', SW_H));
  },

  van: (o) => {
    const w = o.w || 130, h = o.h || 60;
    return rrect(n(-w / 2), n(-h), w, h, R.md, solid('water', 'water_deep', SW_D)) +
      rrect(n(-w / 2 + 10), n(-h + 8), n(w * 0.3), n(h * 0.4), R.sm, solid('sky', 'metal_deep', SW_H)) +
      circle(n(-w * 0.26), 4, 13, solid('metal', 'metal_deep', SW_D)) +
      circle(n(w * 0.26), 4, 13, solid('metal', 'metal_deep', SW_D));
  },

  fan: (o) => {
    const r = o.r || 54;
    const blades = ['petal', 'sun', 'leafy', 'water', 'plum'];
    return blades.map((k, i) => {
      const a0 = (180 / blades.length) * i, a1 = a0 + 180 / blades.length;
      const pt = (a) => ({ x: Math.cos(a * Math.PI / 180) * r, y: -Math.sin(a * Math.PI / 180) * r });
      const p0 = pt(a0), p1 = pt(a1);
      return pathEl(`M0 0L${n(p0.x)} ${n(p0.y)}A${r} ${r} 0 0 0 ${n(p1.x)} ${n(p1.y)}z`, solid(k, `${k}_deep`, SW_H));
    }).join('');
  },

  web: (o) => {
    const r = o.r || 50; let m = '';
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; m += pathEl(`M0 0L${n(Math.cos(a) * r)} ${n(Math.sin(a) * r)}`, line('metal_deep', SW_H)); }
    for (let k = 1; k <= 3; k++) { m += circle(0, 0, n(r * k / 3), { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H, opacity: 0.7 }); }
    return m;
  },

  box: (o) => {
    const w = o.w || 80, h = o.h || 64;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('wood', 'wood_deep', SW_D)) +
      pathEl(`M${n(-w / 2)} ${n(-h * 0.5)}h${n(w)}`, line('wood_deep', SW_H)) +
      pathEl(`M-6 ${n(-h)}l6 ${n(h * 0.5)}l-6 ${n(h * 0.5)}`, line('wood_deep', SW_H));
  },

  peg: (o) => {
    const h = o.h || 50;
    return rrect(-7, n(-h), 14, h, R.sm, solid('wood', 'wood_deep', SW_D)) +
      pathEl(`M0 ${n(-h * 0.4)}V0`, line('wood_deep', SW_H)) +
      circle(0, n(-h * 0.4), 4, { fill: c('metal'), stroke: 'none' });
  },

  rug: (o) => {
    const w = o.w || 110, h = o.h || 60;
    return rrect(n(-w / 2), n(-h / 2), w, h, R.sm, solid('petal', 'petal_deep', SW_D)) +
      rrect(n(-w / 2 + 10), n(-h / 2 + 8), n(w - 20), n(h - 16), R.sm, { fill: 'none', stroke: c('petal_deep'), 'stroke-width': SW_H }) +
      Array.from({ length: 6 }, (_, i) => pathEl(`M${n(-w / 2 + 10 + i * (w - 20) / 5)} ${n(h / 2)}v8`, line('petal_deep', SW_H))).join('');
  },

  mug: (o) => {
    const w = o.w || 50, h = o.h || 52;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('red', 'red_deep', SW_D)) +
      pathEl(`M${n(w / 2)} ${n(-h * 0.7)}q20 0 20 ${n(h * 0.22)}q0 ${n(h * 0.22)} -20 ${n(h * 0.22)}`, { fill: 'none', stroke: c('red_deep'), 'stroke-width': SW_D });
  },

  conker: (o) => pathEl('M-24 4q-4-14 8-18q4-10 16-10t16 10q12 4 8 18q-4 10-24 10t-24-10z', solid('leafy', 'leafy_deep', SW_H)) +
    ellipse(0, -2, 16, 15, solid('hedgehog', 'hedgehog_deep', SW_D)) +
    ellipse(-4, -6, 5, 5, { fill: c('white'), opacity: 0.4, stroke: 'none' }),

  pumpkin: (o) => {
    const w = o.w || 80, h = o.h || 64;
    return [-0.5, -0.17, 0.17, 0.5].map((f) => pathEl(`M${n(f * w / 2)} ${n(-h * 0.1)}q${n(-f * w * 0.16)} ${n(-h * 0.5)} 0 ${n(-h * 0.78)}`, line('sun_deep', SW_H))).join('') +
      ellipse(0, n(-h * 0.42), n(w / 2), n(h * 0.4), solid('sun', 'sun_deep', SW_D)) +
      rrect(-5, n(-h * 0.82 - 10), 10, 14, R.sm, solid('leafy', 'leafy_deep', SW_H));
  },

  apple: (o) => pathEl('M0 -4q-22-6-18-26q3-16 18-10q15-6 18 10q4 20-18 26z', solid('red', 'red_deep', SW_D)) +
    pathEl('M0 -38q4-10 14-12', line('wood_deep', SW_H)) +
    ellipse(-6, -16, 5, 7, { fill: c('white'), opacity: 0.4, stroke: 'none' }),

  mushroom: (o) => pathEl('M-28 0q-4-26 28-28q32 2 28 28z', solid('red', 'red_deep', SW_D)) +
    circle(-10, -16, 4, { fill: c('white'), stroke: 'none' }) + circle(8, -10, 4, { fill: c('white'), stroke: 'none' }) + circle(2, -20, 3, { fill: c('white'), stroke: 'none' }) +
    rrect(-8, 0, 16, 20, R.sm, solid('paper', 'wood_deep', SW_H)),

  spider: (o) => {
    let legs = '';
    for (let i = 0; i < 4; i++) {
      const dy = -10 + i * 7, bend = dy < 0 ? -6 : 6;
      legs += pathEl(`M-10 ${n(dy)}q-14 4 -20 ${n(bend)}`, line('metal_deep', SW_H));
      legs += pathEl(`M10 ${n(dy)}q14 4 20 ${n(bend)}`, line('metal_deep', SW_H));
    }
    return legs + ellipse(0, 6, 14, 12, solid('metal', 'metal_deep', SW_D)) + circle(0, -10, 9, solid('metal', 'metal_deep', SW_D));
  },

  snail: (o) => pathEl('M-26 6q0-20 20-20t20 20q0 14-14 14t-10-10 6-6 4 2', solid('leaf', 'leaf_deep', SW_D)) +
    pathEl('M-26 6q-14 2-14 10t12 6', solid('leaf', 'leaf_deep', SW_H)) +
    pathEl('M-36 16q-4-8 0-14M-30 16q-2-8 2-13', line('leaf_deep', SW_H)),

  worm: (o) => pathEl('M-30 10q10-20 20 0t20 0', { fill: 'none', stroke: c('petal_deep'), 'stroke-width': 11, 'stroke-linecap': 'round' }),

  butterfly: (o) => pathEl('M0 -4q-8-30-30-26q-14 2-6 20q6 12 36 6z', solid('sky', 'sky_deep', SW_H)) +
    pathEl('M0 -4q8-30 30-26q14 2 6 20q-6 12-36 6z', solid('petal', 'petal_deep', SW_H)) +
    pathEl('M0 4q-6 26-24 24q-12 0-6-16q6-10 30-8z', solid('sky', 'sky_deep', SW_H)) +
    pathEl('M0 4q6 26 24 24q12 0 6-16q-6-10-30-8z', solid('petal', 'petal_deep', SW_H)) +
    pathEl('M0 -28V16', line('wood_deep', SW)) +
    pathEl('M0 -28q-6-8-2-14M0 -28q6-8 2-14', line('wood_deep', SW_H)),

  heart: (o) => {
    const k = o.key || 'red';
    return circle(-13, -10, 15, solid(k, `${k}_deep`, SW_D)) +
      circle(13, -10, 15, solid(k, `${k}_deep`, SW_D)) +
      pathEl('M-27 -2q27 34 27 34q0 0 27-34z', solid(k, `${k}_deep`, SW_D));
  },

  mirror: (o) => ellipse(0, -20, 26, 30, solid('sky', 'metal_deep', SW_D)) +
    ellipse(0, -20, 18, 22, { fill: c('white'), opacity: 0.5, stroke: 'none' }) +
    rrect(-6, 16, 12, 34, R.sm, solid('wood', 'wood_deep', SW_H)),

  balloon: (o) => {
    const k = o.key || 'red';
    return ellipse(0, -20, 22, 28, solid(k, `${k}_deep`, SW_D)) +
      pathEl('M0 8l-5 6 5 4 5-4z', solid(k, `${k}_deep`, SW_H)) +
      pathEl('M0 18V50', line('metal_deep', SW_H));
  },

  photo_frame: (o) => {
    const w = o.w || 60, h = o.h || 70;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('wood', 'wood_deep', SW_D)) +
      rrect(n(-w / 2 + 8), n(-h + 8), n(w - 16), n(h - 16), R.sm, solid('sky', 'metal_deep', SW_H));
  },

  candle: (o) => {
    const h = o.h || 70;
    return rrect(-10, n(-h), 20, h, R.sm, solid('paper', 'wood_deep', SW_D)) +
      pathEl(`M0 ${n(-h - 4)}V${n(-h - 14)}`, line('wood_deep', SW_H)) +
      pathEl(`M0 ${n(-h - 14)}q-8-14 0-20q8 6 0 20z`, solid('sun', 'sun_deep', SW_H));
  },

  diya: (o) => pathEl('M-30 0q30 14 60 0q-6 10-30 10t-30-10z', solid('earth', 'earth_deep', SW_D)) +
    pathEl('M0 -4q-8-14 0-22q8 8 0 22z', solid('sun', 'sun_deep', SW_H)),

  menorah: (o) => {
    const xs = [-48, -36, -24, -12, 0, 12, 24, 36, 48];
    let m = rrect(-54, 0, 108, 10, R.sm, solid('metal', 'metal_deep', SW_D));
    xs.forEach((x, i) => {
      const h = i === 4 ? 54 : 40 + (4 - Math.abs(i - 4)) * 4;
      m += rrect(n(x - 4), n(-h), 8, h, R.sm, solid('metal', 'metal_deep', SW_H));
      m += pathEl(`M${n(x)} ${n(-h - 4)}q-5-10 0-16q5 6 0 16z`, solid('sun', 'sun_deep', SW_H));
    });
    return m;
  },

  firework: (o) => {
    const k = o.key || 'red'; let m = '';
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      m += pathEl(`M0 0L${n(Math.cos(a) * 40)} ${n(Math.sin(a) * 40)}`, { fill: 'none', stroke: c(k), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
      m += circle(n(Math.cos(a) * 40), n(Math.sin(a) * 40), 4, { fill: c(k), stroke: 'none' });
    }
    return m;
  },

  present: (o) => {
    const w = o.w || 64, h = o.h || 56;
    return rrect(n(-w / 2), n(-h), w, h, R.sm, solid('red', 'red_deep', SW_D)) +
      rrect(-5, n(-h), 10, h, R.sm, solid('sun', 'sun_deep', SW_H)) +
      rrect(n(-w / 2), n(-h * 0.5 - 4), w, 8, R.sm, solid('sun', 'sun_deep', SW_H)) +
      pathEl(`M-10 ${n(-h)}q-10-18 0-22q10 4 0 22zM10 ${n(-h)}q10-18 0-22q-10 4 0 22z`, solid('sun', 'sun_deep', SW_H));
  },

  christmas_tree: (o) => {
    const h = o.h || 120;
    let m = '';
    for (let i = 0; i < 3; i++) {
      const w = 76 - i * 18, yTop = -(h * 0.32) - i * (h * 0.26), yBot = yTop + h * 0.3;
      m += pathEl(`M0 ${n(yTop)}L${n(w / 2)} ${n(yBot)}H${n(-w / 2)}z`, solid('leafy', 'leafy_deep', SW_D));
    }
    m += rrect(-9, 0, 18, 16, R.sm, solid('wood', 'wood_deep', SW_H));
    const topY = -(h * 0.32) - 2 * (h * 0.26);
    m += pathEl(`M0 ${n(topY - 4)}l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z`, solid('sun', 'sun_deep', SW_H));
    return m;
  },

  snowman: (o) => circle(0, -18, 26, solid('white', 'white_deep', SW_D)) +
    circle(0, -54, 18, solid('white', 'white_deep', SW_D)) +
    circle(-7, -58, 2.5, { fill: c('ink'), stroke: 'none' }) + circle(7, -58, 2.5, { fill: c('ink'), stroke: 'none' }) +
    pathEl('M0 -50l14 4-14 4z', solid('sun', 'sun_deep', SW_H)) +
    circle(0, -30, 3, { fill: c('ink'), stroke: 'none' }) + circle(0, -20, 3, { fill: c('ink'), stroke: 'none' }) + circle(0, -10, 3, { fill: c('ink'), stroke: 'none' }),

  snowflake: (o) => {
    let m = '';
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      m += pathEl(`M0 0L${n(Math.cos(a) * 34)} ${n(Math.sin(a) * 34)}`, { fill: 'none', stroke: c('water_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
      m += pathEl(`M${n(Math.cos(a) * 22)} ${n(Math.sin(a) * 22)}l${n(Math.cos(a + 1) * 8)} ${n(Math.sin(a + 1) * 8)}M${n(Math.cos(a) * 22)} ${n(Math.sin(a) * 22)}l${n(Math.cos(a - 1) * 8)} ${n(Math.sin(a - 1) * 8)}`, line('water_deep', SW_H));
    }
    return m;
  },

  mitten: (o) => pathEl('M-18 10q-10 0-10-14q0-16 10-16q2-10 14-10q14 0 14 14v30q0 10-10 10h-10q-8 0-8-14z', solid('red', 'red_deep', SW_D)) +
    pathEl('M-18 10q-10 0-10-14q0-10 6-13', line('red_deep', SW_H)),

  scarf: (o) => {
    const w = o.w || 90;
    return pathEl(`M${n(-w / 2)} 0q${n(w / 4)} -16 ${n(w / 2)} 0q${n(w / 4)} 16 ${n(w / 2)} 0`, { fill: 'none', stroke: c('leafy'), 'stroke-width': 16, 'stroke-linecap': 'round' }) +
      rrect(n(w / 2 - 6), -4, 14, 46, R.sm, solid('leafy', 'leafy_deep', SW_H)) +
      Array.from({ length: 3 }, (_, i) => pathEl(`M${n(w / 2 - 6 + i * 5)} 42v8`, line('leafy_deep', SW_H))).join('');
  },

  polar_bear: (o) => ellipse(0, -6, 36, 26, solid('white', 'white_deep', SW_D)) +
    circle(30, -30, 16, solid('white', 'white_deep', SW_D)) +
    circle(18, -44, 6, solid('white', 'white_deep', SW_H)) + circle(40, -44, 6, solid('white', 'white_deep', SW_H)) +
    circle(40, -28, 2, { fill: c('ink'), stroke: 'none' }) +
    ellipse(44, -24, 5, 4, solid('metal', 'metal_deep', SW_H)),

  penguin: (o) => ellipse(0, -20, 24, 34, solid('ink', 'ink', SW_D)) +
    ellipse(0, -14, 14, 24, solid('white', 'white_deep', SW_H)) +
    circle(0, -48, 15, solid('ink', 'ink', SW_D)) +
    pathEl('M12 -48l10 4-10 4z', solid('sun', 'sun_deep', SW_H)) +
    pathEl('M-20 -4q-10 10-4 18q8-2 10-12M20 -4q10 10 4 18q-8-2-10-12', solid('ink', 'ink', SW_H)) +
    pathEl('M-8 14q8 6 16 0l-2 8h-12z', solid('sun', 'sun_deep', SW_H)),

  igloo: (o) => {
    const w = o.w || 110;
    return pathEl(`M${n(-w / 2)} 0a${n(w / 2)} ${n(w / 2)} 0 0 1 ${n(w)} 0z`, solid('white', 'white_deep', SW_D)) +
      pathEl(`M${n(-w / 2)} 0h${n(w)}`, line('white_deep', SW_H)) +
      rrect(n(w * 0.08), n(-w * 0.22), n(w * 0.2), n(w * 0.22), R.sm, solid('water', 'water_deep', SW_H)) +
      [0.25, 0.5].map((f) => pathEl(`M${n(-w / 2)} ${n(-f * w * 0.5)}a${n(w / 2)} ${n(w / 2 * (1 - f))} 0 0 0 ${n(w)} 0`, { fill: 'none', stroke: c('white_deep'), 'stroke-width': SW_H, opacity: 0.5 })).join('');
  },

  rocket: (o) => {
    const h = o.h || 120;
    return pathEl(`M0 ${n(-h)}q18 ${n(h * 0.3)} 18 ${n(h * 0.6)}h-36q0 ${n(-h * 0.3)} 18 ${n(-h * 0.6)}z`, solid('metal', 'metal_deep', SW_D)) +
      circle(0, n(-h * 0.55), 9, { fill: c('sky'), stroke: c('metal_deep'), 'stroke-width': SW_H }) +
      pathEl(`M-18 ${n(h * 0.1)}l-14 20h14zM18 ${n(h * 0.1)}l14 20h-14z`, solid('red', 'red_deep', SW_H)) +
      pathEl(`M-10 ${n(h * 0.1)}q10 18 20 0`, solid('sun', 'sun_deep', SW_H));
  },

  planet: (o) => {
    const k = o.key || 'plum';
    return circle(0, 0, 32, solid(k, `${k}_deep`, SW_D)) +
      ellipse(0, 4, 52, 13, { fill: 'none', stroke: c(`${k}_deep`), 'stroke-width': SW_D }) +
      ellipse(0, 4, 52, 13, { fill: c('sun'), opacity: 0.3, stroke: 'none' });
  },

  astronaut: (o) => ellipse(0, -4, 24, 34, solid('white', 'white_deep', SW_D)) +
    circle(0, -44, 20, solid('sky', 'metal_deep', SW_D)) +
    circle(0, -44, 14, { fill: c('metal_deep'), opacity: 0.35, stroke: 'none' }) +
    pathEl('M-24 -4q-16 10-10 26M24 -4q16 10 10 26', solid('white', 'white_deep', SW_H)) +
    pathEl('M-10 28q10 8 20 0l-2 10h-16z', solid('red', 'red_deep', SW_H)),

  alien: (o) => ellipse(0, -6, 22, 28, solid('leafy', 'leafy_deep', SW_D)) +
    circle(-8, -14, 7, solid('ink', 'ink', SW_H)) + circle(8, -14, 7, solid('ink', 'ink', SW_H)) +
    pathEl('M-16 -30q6-14 16-14M16 -30q-6-14-16-14', line('leafy_deep', SW_D)) +
    pathEl('M-10 18q10 8 20 0', line('leafy_deep', SW_H)),

  telescope: (o) => {
    const len = o.len || 90;
    return pathEl(`M-14 0h28l-6 ${n(-len)}h-16z`, solid('metal', 'metal_deep', SW_D)) +
      pathEl(`M-14 ${n(-len * 0.25)}h28M-12 ${n(-len * 0.55)}h24`, line('metal_deep', SW_H)) +
      rrect(-20, -6, 40, 14, R.sm, solid('wood', 'wood_deep', SW_H));
  },

  // Grapheme initial-sound picture cues with no object above yet (b386).
  orange_fruit: (o) => circle(0, 0, 26, solid('sun', 'sun_deep', SW_D)) +
    pathEl('M0 -26q4-10 14-12', line('leafy_deep', SW_H)) +
    ellipse(-8, -10, 5, 7, { fill: c('white'), opacity: 0.3, stroke: 'none' }),

  egg: (o) => ellipse(0, -2, 20, 27, solid('paper', 'earth_deep', SW_D)) +
    circle(-6, -14, 3, { fill: c('earth'), opacity: 0.5, stroke: 'none' }) + circle(6, -6, 2.5, { fill: c('earth'), opacity: 0.5, stroke: 'none' }),

  yo_yo: (o) => pathEl('M0 -40V-10', line('wood_deep', SW_H)) +
    circle(0, 6, 24, solid('red', 'red_deep', SW_D)) +
    circle(0, 6, 8, solid('sun', 'sun_deep', SW_H)),

  zip: (o) => pathEl('M0 -42q-14 10 0 20t0 20t0 20t0 20', { fill: 'none', stroke: c('red_deep'), 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) +
    rrect(-9, 10, 18, 20, R.sm, solid('metal', 'metal_deep', SW_H)),

  thumb: (o) => rrect(-16, -6, 32, 40, R.md, solid('sand', 'sand_deep', SW_D)) +
    pathEl('M-16 -6q0-24 14-30q8 4 2 20q10-2 16 6q6 2 2 10z', solid('sand', 'sand_deep', SW_D)),

  ring: (o) => pathEl('M-22 10a22 22 0 1 1 44 0a22 22 0 1 1 -44 0', { fill: 'none', stroke: c('sun_deep'), 'stroke-width': 8 }) +
    circle(0, -16, 8, solid('water', 'water_deep', SW_H)),

  car: (o) => {
    const w = o.w || 120, h = o.h || 46;
    return pathEl(`M${n(-w / 2)} 0h${n(w)}v${n(-h * 0.4)}q${n(-w * 0.1)} ${n(-h * 0.5)} ${n(-w * 0.3)} ${n(-h * 0.5)}h${n(-w * 0.4)}q${n(-w * 0.1)} 0 ${n(-w * 0.3)} ${n(h * 0.5)}z`, solid('red', 'red_deep', SW_D)) +
      circle(n(-w * 0.28), 4, 13, solid('metal', 'metal_deep', SW_D)) +
      circle(n(w * 0.28), 4, 13, solid('metal', 'metal_deep', SW_D)) +
      rrect(n(-w * 0.18), n(-h * 0.85), n(w * 0.36), n(h * 0.5), R.sm, solid('sky', 'metal_deep', SW_H));
  },

  ear: (o) => pathEl('M-10 20q-20-6-20-28q0-20 20-20q20 0 20 20q0 10-8 14q4 6 0 12q-4 4-12 2z', solid('sand', 'sand_deep', SW_D)) +
    pathEl('M-6 10q6-4 10 2', line('sand_deep', SW_H)),

  hammer: (o) => rrect(-6, -10, 12, 70, R.sm, solid('wood', 'wood_deep', SW_D)) +
    rrect(-26, -34, 52, 26, R.sm, solid('metal', 'metal_deep', SW_D)),

  /* -------------------------------------------------------------------------
   * Added b386b — Printables picture-correctness pass. Three of these replace
   * an EXISTING prop reused for a Printables picture-bank cue that read
   * ambiguously at icon size (nest -> bread, mirror -> lollipop, zip -> a
   * squiggle); rather than edit the original prop (reused by the 43-book
   * pipeline — see PROPS.md), each gets its own new entry so every existing
   * book page keeps its exact current art. `umbrella` is a new initial-/u/
   * picture cue (nursery I-spy / sound mats need a word that genuinely
   * STARTS with the sound, not "bug" where /u/ is the middle sound).
   * ---------------------------------------------------------------------- */

  umbrella: (o) => {
    const k = o.key || 'water';
    return pathEl('M-40 0q0-40 40-40t40 40z', solid(k, `${k}_deep`, SW_D)) +
      pathEl('M-40 0q10 6 20 0t20 0t20 0t20 0', line(`${k}_deep`, SW_H)) +
      pathEl('M0 -40V26q0 10 10 10', { fill: 'none', stroke: c('wood_deep'), 'stroke-width': SW_H });
  },

  // nest + two texture lines are byte-identical to PROPS.nest (never edited —
  // existing books keep rendering the empty nest); three speckled eggs added
  // so a Printables "n is for nest" cue can't be misread as a loaf of bread.
  nest_eggs: () => pathEl('M-46 6q0-30 46-30t46 30q-10 12-46 12t-46-12z', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M-36 -6q22-8 72 0M-30 4q26-6 60 0', line('wood_deep', SW_H)) +
    ellipse(-17, -12, 11, 14, solid('paper', 'earth_deep', SW_H)) +
    ellipse(1, -16, 11, 14, solid('paper', 'earth_deep', SW_H)) +
    ellipse(19, -11, 11, 14, solid('paper', 'earth_deep', SW_H)) +
    circle(-20, -16, 1.6, { fill: c('earth'), opacity: 0.6, stroke: 'none' }) +
    circle(4, -21, 1.6, { fill: c('earth'), opacity: 0.6, stroke: 'none' }) +
    circle(16, -15, 1.6, { fill: c('earth'), opacity: 0.6, stroke: 'none' }),

  // A wide oval (hand-mirror proportions, never a circle) plus a glint, so it
  // can't be misread as a lollipop the way PROPS.mirror's near-circular glass
  // does at icon size. PROPS.mirror itself is untouched.
  hand_mirror: (o) => ellipse(0, -22, 30, 23, solid('sky', 'metal_deep', SW_D)) +
    ellipse(-9, -29, 9, 6, { fill: c('white'), opacity: 0.6, stroke: 'none' }) +
    pathEl('M13 -10l7 7M19 -5l-5 5', { fill: 'none', stroke: c('white'), 'stroke-width': SW_H, opacity: 0.9 }) +
    rrect(-6, 1, 12, 34, R.sm, solid('wood', 'wood_deep', SW_H)),

  // A visible zip track (teeth marks) and pull-tab, so it reads as a
  // fastener rather than PROPS.zip's abstract red squiggle (kept as-is).
  zip_fastener: (o) => {
    let teeth = '';
    for (let y = -36; y <= 34; y += 9) teeth += pathEl(`M-6 ${n(y)}l12 4`, { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H });
    return rrect(-3, -40, 6, 88, R.sm, solid('metal', 'metal_deep', SW_D)) + teeth +
      rrect(-10, -52, 20, 14, R.sm, solid('red', 'red_deep', SW_D)) +
      circle(0, -56, 5, solid('red', 'red_deep', SW_H));
  },

  /* -------------------------------------------------------------------------
   * Added b389 — Wren Printables PSED/C&L/UW/EAD/Display/Role-play batch.
   * Generic classroom/provision/role-play objects and life-cycle stages,
   * same house style (ink outline, rounded corners, palette tokens only),
   * drawn centred near the origin so they sit cleanly inside the picture-
   * bank's fallback icon frame. See picture-bank.js for the registry entries
   * that point at these.
   * ---------------------------------------------------------------------- */

  // A red sand bucket, side view, carry handle up.
  bucket: () => pathEl('M-26 -6q26-10 52 0l-6 46q-20 8-40 0z', solid('red', 'red_deep', SW_D)) +
    pathEl('M-24 -6q24 10 48 0', line('red_deep', SW_H)) +
    pathEl('M-18 -8q18-14 36 0', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D }),

  // A toy spade — wood shaft, flat metal blade.
  spade: () => pathEl('M0 -70V-6', line('wood_deep', SW)) +
    rrect(-16, -6, 32, 34, R.sm, solid('metal', 'metal_deep', SW_D)) +
    pathEl('M-16 6h32', line('metal_deep', SW_H)),

  // A wood-handled paintbrush, loaded tip in a petal tint.
  paintbrush: () => pathEl('M0 36V-18', line('wood_deep', SW)) +
    rrect(-7, -30, 14, 16, R.sm, solid('metal', 'metal_deep', SW_H)) +
    pathEl('M-7 -30q7-18 14 0q-3 14-7 16q-4-2-7-16z', solid('petal', 'petal_deep', SW_H)),

  // A pair of blunt craft scissors — two crossed blades pivoting on a screw,
  // red ring handles at the bottom (review 2026-10-02: the first version was
  // an unrecognisable 'V' of dots; this is the classic crossed-X silhouette).
  scissors: () => {
    const arm = (x1, y1, x2, y2) => pathEl(`M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`, { fill: 'none', stroke: c('metal_deep'), 'stroke-width': 7, 'stroke-linecap': 'round' });
    return arm(-40, -50, 20, 25) + arm(40, -50, -20, 25) +
      circle(0, 0, 5, solid('red', 'red_deep', SW_H)) +
      circle(20, 25, 10, { fill: 'none', stroke: c('red_deep'), 'stroke-width': 4 }) +
      circle(-20, 25, 10, { fill: 'none', stroke: c('red_deep'), 'stroke-width': 4 });
  },

  // A toy building block, letter-blank face (no glyph — used as a generic
  // construction-area icon, never a real reading surface).
  block: () => rrect(-30, -30, 60, 60, R.sm, solid('sun', 'sun_deep', SW_D)) +
    rrect(-16, -16, 32, 32, R.sm, line('sun_deep', SW_H)),

  // A soft-bristle toothbrush, bristles up.
  toothbrush: () => rrect(-7, -10, 14, 60, R.sm, solid('sky', 'sky_deep', SW_H)) +
    rrect(-9, -26, 18, 18, R.sm, solid('white', 'white_deep', SW_H)) +
    pathEl('M-7-24v14M0-26v16M7-24v14', line('white_deep', SW_H)),

  // A bar of soap with a few bubbles.
  soap_bar: () => rrect(-26, -12, 52, 24, R.md, solid('sky', 'sky_deep', SW_D)) +
    circle(24, -28, 7, solid('white', 'white_deep', SW_H)) + circle(36, -16, 5, solid('white', 'white_deep', SW_H)),

  // A simple nursery toilet, side-on — cistern, flat seat, tapering bowl
  // (review 2026-10-02: the first version read as an unrecognisable square
  // and ring; this stacks three clear, familiar shapes top to bottom).
  toilet: () => rrect(-14, -78, 28, 24, R.sm, solid('white', 'white_deep', SW_D)) +
    rrect(-26, -52, 52, 14, R.md, solid('white', 'white_deep', SW_D)) +
    pathEl('M-20 -38q-10 0-10 14v6q0 20 30 20t30-20v-6q0-14-10-14z', solid('white', 'white_deep', SW_D)) +
    ellipse(0, 4, 22, 6, { fill: c('white_deep'), opacity: 0.25, stroke: 'none' }),

  // An open hand, five fingers spread — the keepsake handprint outline.
  handprint: () => pathEl(
    'M-8 40q-16 0-16-14v-30q0-8 8-8t8 8v16q0-8 8-14l4-28q0-8 8-8t8 8l-2 30q4-10 10-16l6-20q2-8 9-6t5 9l-5 20q6-6 12-8l8-10q6-6 11-1t0 11l-16 18q10-2 16 2t-2 12l-18 10q6 20-6 32q-10 10-28 10z',
    solid('sand', 'sand_deep', SW_D)),

  // A plain envelope with a triangular flap.
  envelope: () => rrect(-34, -24, 68, 48, R.sm, solid('paper', 'ink', SW_D)) +
    pathEl('M-34 -24l34 26 34-26', line('ink', SW_H)),

  // A shop till — box body, small screen, coin slot.
  till: () => rrect(-34, -26, 68, 40, R.sm, solid('metal', 'metal_deep', SW_D)) +
    rrect(-24, -20, 32, 16, R.sm, solid('sky', 'sky_deep', SW_H)) +
    rrect(-8, 10, 40, 8, R.sm, solid('metal_deep', 'metal_deep', SW_H)) +
    circle(22, 2, 4, { fill: c('ink'), stroke: 'none' }),

  // A medical cross on a round badge — doubles for doctor and vet props.
  medical_cross: () => circle(0, 0, 30, solid('white', 'red_deep', SW_D)) +
    pathEl('M-6-18h12v12h12v12h-12v12h-12v-12h-12v-12h12z', solid('red', 'red_deep', SW_H)),

  // A magnifying glass — ring lens + angled handle.
  magnifying_glass: () => circle(-6, -6, 26, solid('sky', 'metal_deep', SW_D)) +
    pathEl('M14 14l22 22', { fill: 'none', stroke: c('wood_deep'), 'stroke-width': 9, 'stroke-linecap': 'round' }),

  // A watering can — body, spout, carry handle, a few drips.
  watering_can: () => pathEl('M-28 -4q0-20 28-20t28 20l-6 30q-22 8-44 0z', solid('metal', 'metal_deep', SW_D)) +
    pathEl('M18 -18l26-10q10-2 10 8t-10 10l-22 8z', solid('metal', 'metal_deep', SW_H)) +
    pathEl('M-16 -22q6-14 16 0', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D }) +
    circle(46, -22, 3, solid('water', 'water_deep', SW_H)) + circle(52, -14, 3, solid('water', 'water_deep', SW_H)),

  // ---- life-cycle stages (b389) — drawn plainly so the SHAPE teaches the
  // stage; scientifically-ordered sets live in scripts/printables/lifecycles.js.
  tadpole: () => ellipse(-6, 0, 20, 15, solid('leaf', 'leaf_deep', SW_D)) +
    pathEl('M14 0q24 6 24 -2t-24-6', solid('leaf', 'leaf_deep', SW_H)),

  froglet: () => ellipse(0, 4, 24, 18, solid('leaf', 'leaf_deep', SW_D)) +
    pathEl('M18 10q20 2 20-4t-18-8', solid('leaf', 'leaf_deep', SW_H)) +
    pathEl('M-14 18q-2 14-12 16M10 20q2 14 12 16', { fill: 'none', stroke: c('leaf_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' }) +
    circle(-10, -10, 5, { fill: EYE.ink, stroke: 'none' }) + circle(10, -10, 5, { fill: EYE.ink, stroke: 'none' }),

  // A hanging chrysalis — teardrop with faint segment bands.
  chrysalis: () => pathEl('M0 -40q18 10 18 36q0 26-18 32q-18-6-18-32q0-26 18-36z', solid('leaf', 'leaf_deep', SW_D)) +
    pathEl('M-14 -4h28M-13 10h26M-11 22h22', line('leaf_deep', SW_H)) +
    pathEl('M0-40v-10', line('wood_deep', SW_H)),

  // A fluffy round chick, distinct (smaller, rounder, no comb) from the adult hen.
  chick: () => circle(0, 6, 24, solid('sun', 'sun_deep', SW_D)) +
    circle(16, -16, 14, solid('sun', 'sun_deep', SW_D)) +
    pathEl('M28 -16l14 5-14 7z', solid('brick', 'brick_deep', SW_H)) +
    circle(20, -20, 3, { fill: EYE.ink, stroke: 'none' }),

  // A single bean seed.
  bean_seed: () => pathEl('M0 -16q16 4 16 16q0 16-16 20q-16-4-16-20q0-12 16-16z', solid('wood', 'wood_deep', SW_D)),

  // A small seedling — two leaves on a stem, poking from a soil mound.
  seedling: () => ellipse(0, 14, 26, 8, solid('earth', 'earth_deep', SW_H)) +
    pathEl('M0 14V-10', line('grass_deep', SW_D)) +
    pathEl('M0-6q-18-4-20-18q16 0 20 14z', solid('leafy', 'leafy_deep', SW_H)) +
    pathEl('M0-10q18-4 20-18q-16 0-20 14z', solid('leafy', 'leafy_deep', SW_H)),

  // ---- senses icons (b389, UW concept posters) ----
  eye_prop: () => pathEl('M-30 0q30-22 60 0q-30 22-60 0z', solid('white', 'white_deep', SW_D)) +
    circle(0, 0, 11, { fill: EYE.ink, stroke: 'none' }) + circle(3, -3, 3.5, { fill: c('white'), stroke: 'none' }),

  nose: () => pathEl('M-10 -26q-14 20-10 34q3 10 14 10t14-10q4-14-10-34z', solid('sand', 'sand_deep', SW_D)) +
    circle(-6, 14, 2.6, { fill: c('sand_deep'), opacity: 0.6, stroke: 'none' }) + circle(6, 14, 2.6, { fill: c('sand_deep'), opacity: 0.6, stroke: 'none' }),

  mouth_icon: () => pathEl('M-26 -4q26 24 52 0q-4 20-26 20t-26-20z', solid('red', 'red_deep', SW_D)) +
    pathEl('M-22 -2q22 14 44 0', line('red_deep', SW_H)),

  // A simple closed storybook, side-on — cover, spine and page-edge lines.
  // Added b389 because PROPS.book_prop (an open book seen from above, built
  // for a tabletop scene) reads as an unrecognisable wing shape when cropped
  // tight as a standalone icon (review 2026-10-02); this one is unambiguous
  // at icon size for a reading-area/routine context. book_prop is untouched.
  book_closed: () => rrect(-34, -44, 68, 56, R.sm, solid('red', 'red_deep', SW_D)) +
    rrect(-34, -44, 10, 56, R.sm, solid('red_deep', 'red_deep', SW_H)) +
    pathEl('M-14 -44v56M-2 -44v56M10 -44v56', line('white', SW_H)),

  // A squashed ball of playdough, finger-dimpled — the malleable-area icon.
  dough_ball: () => pathEl('M-32 6q-4-26 32-30t32 30q0 22-32 22t-32-22z', solid('petal', 'petal_deep', SW_D)) +
    circle(-10, -2, 4, { fill: c('petal_deep'), opacity: 0.4, stroke: 'none' }) +
    circle(8, 4, 5, { fill: c('petal_deep'), opacity: 0.4, stroke: 'none' }),

  /* -------------------------------------------------------------------------
   * Added b390 — Wren Printables self-care step pictures (every step on a
   * C05 poster needs its own picture, not just one shared across six steps)
   * plus a generic-feelings face (eyes+brows+mouth only, flat colour — the
   * cast's 4 eye modes cannot show sad/cross/scared/surprised/worried) and
   * a batch of new theme objects for the full-year theme set. Same house
   * style (ink outline, rounded corners, palette tokens only).
   * ---------------------------------------------------------------------- */

  // A simple round face, NOT a cast member — eyes, brows and mouth only, so
  // the feeling reads from the face alone at 30mm. o.feeling picks the set;
  // o.skin picks the face tone (palette token, default 'sand').
  feelings_face: (o) => {
    const skin = o.skin || 'sand';
    const f = o.feeling || 'happy';
    const head = circle(0, 0, 46, solid(skin, `${skin}_deep`, SW_D));
    const browL = (d) => pathEl(d, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
    const dotEye = (x) => circle(x, -10, 5, { fill: c('ink'), stroke: 'none' });
    const closedEye = (x) => pathEl(`M${n(x - 7)} -10q7 6 14 0`, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H, 'stroke-linecap': 'round' });
    const sideEye = (x) => circle(x + 2, -10, 4, { fill: c('ink'), stroke: 'none' });
    const blush = cheek(-28, 10, 1.1) + cheek(28, 10, 1.1);
    let eyes, brows, mouth, extra = '';
    if (f === 'happy') {
      eyes = dotEye(-16) + dotEye(16);
      brows = browL('M-24 -24q8-4 16 0') + browL('M8 -24q8-4 16 0');
      mouth = pathEl('M-20 12q20 18 40 0', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
    } else if (f === 'excited') {
      eyes = circle(-16, -12, 7, { fill: c('ink'), stroke: 'none' }) + circle(16, -12, 7, { fill: c('ink'), stroke: 'none' });
      brows = browL('M-26 -28q8-6 18-2') + browL('M8 -30q10-4 18 2');
      mouth = pathEl('M-22 10q22 24 44 0q-22 10-44 0z', solid('white', 'red_deep', SW_D)) +
        pathEl('M-16 12h32', line('red_deep', SW_H));
    } else if (f === 'sad') {
      eyes = dotEye(-16) + dotEye(16);
      // Claude review 2026-10-03: sad brows read as cross. Sad = INNER ends raised
      // (soft, like worried) + down-turned mouth + a tear.
      brows = browL('M-27 -15q9-1 19-10') + browL('M27 -15q-9-1 -19-10');
      mouth = pathEl('M-18 22q18-14 36 0', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
      extra = pathEl('M18 2q4 8 0 14', { fill: 'none', stroke: c('water_deep'), 'stroke-width': SW_H, 'stroke-linecap': 'round' });
    } else if (f === 'cross') {
      // Angry brows: outer corner HIGH, inner corner LOW (a straight "\  /"
      // meeting low at the nose) — the opposite slope to 'worried', so the
      // two are never ambiguous at a glance.
      eyes = dotEye(-16) + dotEye(16);
      brows = browL('M-28 -28L-7 -13') + browL('M28 -28L7 -13');
      mouth = pathEl('M-15 19h30', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
    } else if (f === 'scared') {
      // Same worried-style inner-up brow as 'worried', pulled higher and
      // steeper, over WIDE eyes and a small tight mouth — distinct from
      // 'worried' (small eyes) and from 'surprised' (level raised brows,
      // big open mouth) even though all three share the "uh-oh" family.
      eyes = circle(-16, -10, 7, { fill: c('ink'), stroke: 'none' }) + circle(16, -10, 7, { fill: c('ink'), stroke: 'none' });
      brows = browL('M-30 -18L-8 -34') + browL('M30 -18L8 -34');
      mouth = ellipse(0, 19, 6, 8, solid('white', 'red_deep', SW_H));
    } else if (f === 'surprised') {
      // Level, raised brows (not angled) + wide eyes + a big open "wow"
      // mouth — the brows' flat slope is what reads as surprised rather
      // than scared.
      eyes = circle(-16, -12, 8, { fill: c('ink'), stroke: 'none' }) + circle(16, -12, 8, { fill: c('ink'), stroke: 'none' });
      brows = browL('M-29 -32q10-5 20 0') + browL('M9 -32q10-5 20 0');
      mouth = ellipse(0, 19, 12, 15, solid('white', 'red_deep', SW_H));
    } else if (f === 'worried') {
      // Mild concern: inner corner HIGH, outer corner LOW — opposite slope
      // to 'cross', small (dot) eyes, mouth a shallow open wobble.
      eyes = dotEye(-16) + dotEye(16);
      brows = browL('M-28 -14L-7 -25') + browL('M28 -14L7 -25');
      mouth = pathEl('M-13 18q13-5 26 0', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H, 'stroke-linecap': 'round' });
    } else if (f === 'calm') {
      eyes = closedEye(-16) + closedEye(16);
      brows = browL('M-24 -22q8-3 16 0') + browL('M8 -22q8-3 16 0');
      mouth = pathEl('M-12 14q12 8 24 0', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H, 'stroke-linecap': 'round' });
    } else { // shy
      eyes = sideEye(-18) + sideEye(10);
      brows = browL('M-24 -22q8-3 16 0') + browL('M8 -22q8-3 16 0');
      mouth = pathEl('M-10 14q10 7 20 0', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H, 'stroke-linecap': 'round' });
      extra = blush;
    }
    return head + eyes + brows + mouth + extra;
  },

  // Running tap water — the existing `tap` PROP's spout tip sits at
  // (38,-46) in ITS OWN local space; this is a self-contained fixture (a
  // smaller tap body + a falling stream + a small splash) sized to be one
  // step picture on a self-care poster, not a scene prop.
  tap_running: () => rrect(-15, -10, 30, 13, R.sm, solid('metal', 'metal_deep', SW_D)) +
    rrect(-8, -58, 16, 50, R.sm, solid('metal', 'metal_deep', SW_D)) +
    pathEl('M8 -52q22 0 22 16v10', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': 11, 'stroke-linecap': 'round' }) +
    pathEl('M8 -52q22 0 22 16v10', { fill: 'none', stroke: c('metal'), 'stroke-width': 6, 'stroke-linecap': 'round' }) +
    pathEl('M24 -22q-4 20 0 34', { fill: 'none', stroke: c('water'), 'stroke-width': 8, 'stroke-linecap': 'round' }) +
    ellipse(24, 18, 14, 5, { fill: c('water'), opacity: 0.5, stroke: 'none' }),

  // Two hands rubbing together with a few soap bubbles — mitten-shaped (no
  // fingers drawn, per the brief), o.skin varies the tone across a set.
  hands_rubbing: (o) => {
    const skin = o.skin || 'sand';
    const hand = (x, rot) => group(
      pathEl('M-22 10q-6-26 10-34q18-8 30 6q10 12 2 26q-8 14-26 14q-12 0-16-12z', solid(skin, `${skin}_deep`, SW_D)),
      { transform: `translate(${n(x)} 0) rotate(${n(rot)})` });
    return hand(-14, -18) + hand(14, 18) +
      circle(2, -34, 5, solid('white', 'white_deep', SW_H)) + circle(14, -42, 4, solid('white', 'white_deep', SW_H)) +
      circle(-10, -40, 3.5, solid('white', 'white_deep', SW_H));
  },

  // Two hands held under a falling stream, rinsing the soap away (no
  // bubbles — distinguishes this step from hands_rubbing at a glance).
  hands_rinsing: (o) => {
    const skin = o.skin || 'earth';
    const hand = (x, rot) => group(
      pathEl('M-22 10q-6-26 10-34q18-8 30 6q10 12 2 26q-8 14-26 14q-12 0-16-12z', solid(skin, `${skin}_deep`, SW_D)),
      { transform: `translate(${n(x)} 14) rotate(${n(rot)})` });
    return hand(-14, -14) + hand(14, 14) +
      pathEl('M-6 -54q-3 18 0 30M6 -54q3 18 0 30', { fill: 'none', stroke: c('water'), 'stroke-width': 7, 'stroke-linecap': 'round' });
  },

  // A folded hand towel, hung over an unseen rail — fold lines only, no rail
  // drawn, so it reads as a towel at any crop.
  towel: () => rrect(-28, -34, 56, 60, R.sm, solid('sky', 'sky_deep', SW_D)) +
    pathEl('M-28 -14h56M-28 6h56', line('sky_deep', SW_H)),

  // A toothpaste tube, cap off, a pea-sized blob of paste on top.
  toothpaste_tube: () => rrect(-18, -36, 36, 60, R.sm, solid('white', 'white_deep', SW_D)) +
    pathEl('M-18 -36q0-12 18-12t18 12', solid('sky', 'sky_deep', SW_H)) +
    pathEl('M-18 -8h36', line('sky_deep', SW_H)) +
    ellipse(0, -54, 9, 6, solid('white', 'white_deep', SW_H)),

  // A smiling mouth with teeth showing — distinct from mouth_icon (a plain
  // closed smile) because a brushing poster needs to show WHAT is brushed.
  smiling_teeth: () => pathEl('M-32 -4q32 30 64 0q-6 26-32 26t-32-26z', solid('red', 'red_deep', SW_D)) +
    rrect(-26, -4, 52, 16, R.sm, solid('white', 'white_deep', SW_H)) +
    pathEl('M-13 -4v16M0 -4v16M13 -4v16', line('white_deep', SW_H)),

  // A sand-timer (hourglass) for "two minutes" — no numerals, so it never
  // implies a literal reading age.
  timer_sand: () => pathEl('M-20 -46h40l-16 34 16 34h-40l16-34z', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M-14 -40q14 24 0 34M14 -40q-14 24 0 34', { fill: 'none', stroke: c('sky'), 'stroke-width': SW_H }) +
    pathEl('M-10 18l10-10 10 10z', solid('sand', 'sand_deep', SW_H)) +
    rrect(-24, -50, 48, 8, R.sm, solid('wood_deep', 'wood_deep', SW_H)) +
    rrect(-24, 42, 48, 8, R.sm, solid('wood_deep', 'wood_deep', SW_H)),

  // A spare toilet-roll on a wall holder, perforation lines on the visible
  // sheet so it reads as paper, not a plain tube.
  toilet_roll: () => ellipse(0, -34, 20, 10, solid('white', 'white_deep', SW_D)) +
    rrect(-20, -34, 40, 48, 0, solid('white', 'white_deep', SW_D)) +
    pathEl('M-20 -18h40M-20 -2h40M-20 14h40', line('white_deep', SW_H)) +
    pathEl('M-24 -34q0-8 24-8t24 8', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D }),

  // A wall flush button, two concentric rings on a small plate.
  flush_button: () => rrect(-20, -26, 40, 52, R.md, solid('metal', 'metal_deep', SW_D)) +
    circle(0, 0, 14, solid('white', 'white_deep', SW_H)) +
    circle(0, 0, 6, { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H }),

  // ---- full-year theme objects (b390) — one simple new silhouette each,
  // reusing palette tokens only. Many themes lean on EXISTING props
  // (farm/pets/food/construction animals and objects already drawn for the
  // phonics books) — see picture-bank.js for which themes need no new art.
  // A friendly long-necked dinosaur (brontosaurus silhouette — the most
  // toddler-recognisable dinosaur shape): round body, long curved neck and
  // tail, small head, triangular back spikes.
  dinosaur: (o) => {
    const key = o.key || 'leafy';
    return pathEl('M-44 30q-18 2-26-10t4-18q-2-16 16-20q4-18 30-18q6-20 22-14q10 4 6 16q22 2 26 22q10 2 10 12t-12 10l-4 16q-2 8-10 6t-4-10l2-10q-14 6-28 2q-12-2-20-8q-4 14-12 20q-6 4-10-2t2-10z', solid(key, `${key}_deep`, SW_D)) +
      pathEl('M-16-58l-4-14M-4-64l-2-15M8-62l0-15', { fill: 'none', stroke: c(`${key}_deep`), 'stroke-width': SW_D, 'stroke-linecap': 'round' }) +
      ellipse(-32, -4, 10, 7, solid(key, `${key}_deep`, SW_H)) +
      circle(-36, -8, 3.5, { fill: c('ink'), stroke: 'none' }) +
      ellipse(-20, 38, 10, 6, solid(`${key}_deep`, `${key}_deep`, SW_H)) + ellipse(14, 40, 10, 6, solid(`${key}_deep`, `${key}_deep`, SW_H));
  },

  // A lion's face — a solid scalloped mane (overlapping filled discs, not
  // thin rays, so it reads as fur rather than a sun) behind a round face.
  lion: () => {
    let mane = '';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      mane += circle(n(Math.cos(a) * 34), n(Math.sin(a) * 34), 16, solid('gold_deep', 'gold_deep', 0));
    }
    return mane +
      circle(0, 0, 30, solid('gold', 'gold_deep', SW_D)) +
      ellipse(0, 12, 14, 10, solid('sand', 'sand_deep', SW_H)) +
      circle(-10, -2, 3.5, { fill: c('ink'), stroke: 'none' }) + circle(10, -2, 3.5, { fill: c('ink'), stroke: 'none' }) +
      pathEl('M0 8l-6 7h12z', solid('ink', 'ink', SW_H)) +
      pathEl('M-24 -26l-10-9M24 -26l10-9', { fill: 'none', stroke: c('sand'), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
  },

  elephant: () => pathEl('M-10 -30q34 0 38 32q4 30-18 40q4 10-4 12t-10-8q-16 4-28-4q-4 10-12 8t-2-12q-16-10-12-32q4-28 24-36z', solid('metal', 'metal_deep', SW_D)) +
    pathEl('M-36 -2q-18 2-20 20q-2 14 10 16', solid('metal', 'metal_deep', SW_D)) +
    pathEl('M24 -16q22-10 30 4t-8 22', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': 9, 'stroke-linecap': 'round' }) +
    ellipse(-14, -28, 11, 8, solid('metal_deep', 'metal_deep', SW_H)) +
    circle(-6, -18, 3, { fill: c('ink'), stroke: 'none' }),

  // A seated monkey — round ears, muzzle patch, ONE curling tail (not a
  // mirrored pair, which read as two dangling arms in an earlier draft).
  monkey: () => circle(0, 6, 30, solid('earth', 'earth_deep', SW_D)) +
    circle(-28, -8, 11, solid('earth', 'earth_deep', SW_H)) + circle(28, -8, 11, solid('earth', 'earth_deep', SW_H)) +
    ellipse(0, 10, 16, 13, solid('sand', 'sand_deep', SW_H)) +
    ellipse(-20, 44, 11, 8, solid('earth', 'earth_deep', SW_H)) + ellipse(20, 44, 11, 8, solid('earth', 'earth_deep', SW_H)) +
    pathEl('M26 40q22 4 20 26q-2 16-20 10', { fill: 'none', stroke: c('earth_deep'), 'stroke-width': 8, 'stroke-linecap': 'round' }) +
    circle(-9, 4, 3, { fill: c('ink'), stroke: 'none' }) + circle(9, 4, 3, { fill: c('ink'), stroke: 'none' }),

  pirate_ship: () => pathEl('M-56 10l10 26h92l10-26z', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M0 10V-70', line('wood_deep', SW_D)) +
    pathEl('M4 -70q40 6 40 34h-40z', solid('paper', 'ink', SW_D)) +
    pathEl('M0-70l-18 10 18 8z', solid('red', 'red_deep', SW_H)) +
    pathEl('M-56 10h112', line('wood_deep', SW_H)),

  treasure_chest: () => rrect(-36, -6, 72, 34, R.sm, solid('wood', 'wood_deep', SW_D)) +
    pathEl('M-36 -6q0-26 36-26t36 26z', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M-36 -6h72M-6 -6v34', line('gold_deep', SW_H)) +
    rrect(-7, -14, 14, 14, R.sm, solid('gold', 'gold_deep', SW_H)) +
    circle(-20, 18, 5, solid('gold', 'gold_deep', SW_H)) + circle(14, 20, 5, solid('gold', 'gold_deep', SW_H)),

  train: () => rrect(-44, -30, 88, 44, R.md, solid('red', 'red_deep', SW_D)) +
    rrect(-34, -56, 30, 28, R.sm, solid('red', 'red_deep', SW_D)) +
    rrect(14, -70, 14, 16, R.sm, solid('metal', 'metal_deep', SW_H)) +
    circle(-24, -44, 9, solid('sky', 'sky_deep', SW_H)) +
    circle(-24, 14, 13, solid('metal_deep', 'metal_deep', SW_H)) + circle(10, 14, 13, solid('metal_deep', 'metal_deep', SW_H)) + circle(32, 14, 13, solid('metal_deep', 'metal_deep', SW_H)),

  poppy: () => {
    const petal = (rot) => group(ellipse(0, -20, 15, 20, solid('red', 'red_deep', SW_H)), { transform: `rotate(${n(rot)})` });
    return petal(0) + petal(90) + petal(180) + petal(270) + circle(0, 0, 10, solid('ink', 'ink', SW_H)) +
      pathEl('M0 10V46', line('leafy_deep', SW_D));
  },

  // A round paper lantern — a bulging barrel silhouette (not a straight
  // box, which read as a gift or a barrel), ribbed, with gold caps top and
  // bottom and a hanging loop + tassel. o.key (default 'berry') recolours
  // for lunar-new-year (berry/red) vs ramadan-eid (gold) — same shape.
  lantern: (o) => {
    const key = o.key || 'berry';
    return pathEl('M-28 -30q-10 34 0 68q28 10 56 0q10-34 0-68q-28-10-56 0z', solid(key, `${key}_deep`, SW_D)) +
      pathEl('M-24 -14q24 8 48 0M-26 10q26 8 52 0M-24 34q24 8 48 0', line(`${key}_deep`, SW_H)) +
      rrect(-14, -44, 28, 16, R.sm, solid('gold', 'gold_deep', SW_H)) +
      rrect(-14, 38, 28, 16, R.sm, solid('gold', 'gold_deep', SW_H)) +
      pathEl('M-8 -44q8-14 16 0', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H }) +
      pathEl('M0 54v16', { fill: 'none', stroke: c('gold_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
  },

  sandcastle: () => {
    const tower = (x, h) => rrect(x - 12, -h, 24, h, R.sm, solid('sand', 'sand_deep', SW_D)) +
      pathEl(`M${n(x - 12)} ${n(-h)}v-10h6v8h6v-8h6v8h6v-8h6v10z`, solid('sand', 'sand_deep', SW_H));
    return ellipse(0, 36, 70, 14, solid('sand', 'sand_deep', SW_D)) +
      tower(-28, 46) + tower(0, 64) + tower(28, 46) +
      pathEl('M0 -64v-20l16 8-16 8z', solid('petal', 'petal_deep', SW_H));
  },

  beach_ball: () => {
    const seg = (a0, a1, key) => pathEl(`M0 0L${n(Math.cos(a0) * 40)} ${n(Math.sin(a0) * 40)}A40 40 0 0 1 ${n(Math.cos(a1) * 40)} ${n(Math.sin(a1) * 40)}z`, solid(key, `${key}_deep`, SW_H));
    const cols = ['red', 'sun', 'sky', 'leafy', 'petal', 'water'];
    let m = '';
    for (let i = 0; i < 6; i++) m += seg((i / 6) * 2 * Math.PI, ((i + 1) / 6) * 2 * Math.PI, cols[i]);
    return m + circle(0, 0, 40, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D });
  },

  // o.key (default 'berry', b392) recolours the cape for a second/third
  // superhero costume colourway — same cut, different cloth.
  cape: (o = {}) => {
    const key = o.key || 'berry';
    return pathEl('M-28 -36q28-10 56 0l10 70q-38 14-76 0z', solid(key, `${key}_deep`, SW_D)) +
      pathEl('M-28 -36q28-10 56 0', line(`${key}_deep`, SW_H)) +
      pathEl('M0 -10l7 14-7 14-7-14z', solid('sun', 'sun_deep', SW_H));
  },

  // o.key (default 'plum', b392) recolours the mask.
  mask: (o = {}) => {
    const key = o.key || 'plum';
    return pathEl('M-46 -2q10-18 30-18t20 14q0-16 20-14t30 18q-8 14-26 12q-14-2-24-14q-10 12-24 14q-18 2-26-12z', solid(key, `${key}_deep`, SW_D)) +
      pathEl('M-46 -2q6 4 4 10M46 -2q-6 4-4 10', { fill: 'none', stroke: c(`${key}_deep`), 'stroke-width': SW_H, 'stroke-linecap': 'round' });
  },

  castle: () => rrect(-50, -10, 100, 50, 0, solid('sand', 'sand_deep', SW_D)) +
    pathEl('M-50 -10h12v-14h-12zM-20 -10h12v-14h-12zM8 -10h12v-14h-12zM38 -10h12v-14h-12z', solid('sand', 'sand_deep', SW_H)) +
    rrect(-44, -46, 20, 40, R.sm, solid('sand', 'sand_deep', SW_D)) +
    rrect(24, -46, 20, 40, R.sm, solid('sand', 'sand_deep', SW_D)) +
    pathEl('M-44 -46l10-16 10 16zM24 -46l10-16 10 16z', solid('berry', 'berry_deep', SW_H)) +
    pathEl('M-8 40q0-22 8-22t8 22z', solid('wood', 'wood_deep', SW_H)),

  // A classic black-pentagon-on-white football, one bold centred pentagon
  // plus three part-pentagons at the rim (not a thin pinwheel of lines).
  football: () => {
    const pent = (cx, cy, r, rot) => {
      let d = '';
      for (let i = 0; i < 5; i++) {
        const a = rot + (i / 5) * 2 * Math.PI - Math.PI / 2;
        d += `${i ? 'L' : 'M'}${n(cx + Math.cos(a) * r)} ${n(cy + Math.sin(a) * r)}`;
      }
      return pathEl(`${d}z`, { fill: c('ink'), stroke: c('ink'), 'stroke-width': SW_H, 'stroke-linejoin': 'round' });
    };
    return circle(0, 0, 38, solid('white', 'ink', SW_D)) +
      pent(0, -4, 15, 0) + pent(-32, 18, 9, 0.6) + pent(32, 18, 9, -0.6) + pent(0, 40, 9, Math.PI);
  },

  // A tied bundle of wheat — stalks topped with bristled, pointed grain
  // spikes (not plain round balls), gathered with a ribbon band.
  wheat_sheaf: () => {
    const spike = (x, lean) => {
      const tx = x + lean * 1.6, ty = -50;
      let m = pathEl(`M${n(x)} 42Q${n(x + lean)} 0 ${n(tx)} ${n(ty)}`, { fill: 'none', stroke: c('gold_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' });
      m += pathEl(`M${n(tx)} ${n(ty + 30)}q-3-28 0-34q3 6 0 34z`, solid('gold', 'gold_deep', SW_H));
      for (let i = 0; i < 5; i++) {
        const y = ty + 6 + i * 6;
        m += pathEl(`M${n(tx)} ${n(y)}l-8-5M${n(tx)} ${n(y)}l8-5`, { fill: 'none', stroke: c('gold_deep'), 'stroke-width': 1.5, 'stroke-linecap': 'round' });
      }
      return m;
    };
    return spike(-18, -5) + spike(-6, -2) + spike(6, 2) + spike(18, 5) +
      pathEl('M-22 12q22 10 44 0', { fill: 'none', stroke: c('brick_deep'), 'stroke-width': 8, 'stroke-linecap': 'round' });
  },

  globe: () => circle(0, 0, 40, solid('water', 'water_deep', SW_D)) +
    ellipse(0, 0, 40, 14, { fill: 'none', stroke: c('water_deep'), 'stroke-width': SW_H }) +
    pathEl('M0 -40V40', { fill: 'none', stroke: c('water_deep'), 'stroke-width': SW_H }) +
    pathEl('M-24 -22q-10 14 2 24t-4 20', solid('leafy', 'leafy_deep', SW_H)) +
    pathEl('M14 -10q16 2 14 18t-10 16', solid('leafy', 'leafy_deep', SW_H)),

  // o.key (default 'sky', b392) recolours the flag's cloth for a second
  // around-the-world flag — same pole/shape, a different nation's colour.
  flag: (o = {}) => {
    const key = o.key || 'sky';
    return pathEl('M-4 -60V50', { fill: 'none', stroke: c('wood_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' }) +
      pathEl('M-4 -58q30-8 46 0t0 34q-30 8-46 0z', solid(key, `${key}_deep`, SW_D));
  },

  firefighter_helmet: () => pathEl('M-32 10q-4-38 32-44t32 44z', solid('red', 'red_deep', SW_D)) +
    pathEl('M-38 10h76', { fill: 'none', stroke: c('red_deep'), 'stroke-width': 8, 'stroke-linecap': 'round' }) +
    circle(0, -6, 11, solid('gold', 'gold_deep', SW_H)),

  police_hat: () => rrect(-38, -8, 76, 20, R.sm, solid('ink', 'ink', SW_D)) +
    pathEl('M-34 -8q4-24 34-24t34 24z', solid('ink', 'ink', SW_D)) +
    circle(0, -6, 9, solid('gold', 'gold_deep', SW_H)) +
    pathEl('M-38 12q0 8 8 8h60q8 0 8-8z', solid('ink', 'ink', SW_H)),

  rabbit: () => circle(0, 14, 26, solid('white', 'white_deep', SW_D)) +
    circle(0, -24, 20, solid('white', 'white_deep', SW_D)) +
    ellipse(-12, -58, 8, 30, solid('white', 'white_deep', SW_D)) + ellipse(12, -58, 8, 30, solid('white', 'white_deep', SW_D)) +
    ellipse(-12, -54, 4, 20, solid('petal', 'petal_deep', SW_H)) + ellipse(12, -54, 4, 20, solid('petal', 'petal_deep', SW_H)) +
    circle(-8, -28, 3, { fill: c('ink'), stroke: 'none' }) + circle(8, -28, 3, { fill: c('ink'), stroke: 'none' }) +
    pathEl('M0 -18l-6 6h12z', solid('sand', 'sand_deep', SW_H)) +
    circle(0, 38, 10, solid('white', 'white_deep', SW_H)),

  /* -------------------------------------------------------------------------
   * Added b392 — Wren Printables "enough pictures for every theme": every
   * theme needed new, genuinely DISTINCT objects (not a recolour of one
   * shape) to clear the 12-picture bar for picture-heavy sheets. Same house
   * style as everything above (ink outline, rounded corners, palette
   * tokens only, no bare hex). Grouped by the theme that needed them first;
   * several are reused by more than one theme (see picture-bank.js).
   * ---------------------------------------------------------------------- */

  // ---- pumpkins-and-halloween ----
  bat: () => pathEl('M-50 2Q-66-28-34-20Q-18-34 0-18Q18-34 34-20Q66-28 50 2Q30-10 14 4Q6-4 0 4Q-6-4-14 4Q-30-10-50 2Z', solid('ink', 'ink', SW_D)) +
    circle(0, -4, 14, solid('ink', 'ink', SW_H)) +
    pathEl('M-8-14l-4-10 8 4zM8-14l4-10-8 4z', solid('ink', 'ink', SW_H)) +
    circle(-5, -6, 2.2, { fill: c('sun'), stroke: 'none' }) + circle(5, -6, 2.2, { fill: c('sun'), stroke: 'none' }),

  ghost: () => pathEl('M-32 10Q-40-40 0-40T32 10Q24 2 16 10T0 10T-16 10T-32 10Z', solid('white', 'white_deep', SW_D)) +
    circle(-10, -10, 3.5, { fill: c('ink'), stroke: 'none' }) + circle(10, -10, 3.5, { fill: c('ink'), stroke: 'none' }) +
    pathEl('M-8 2q8 6 16 0', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H, 'stroke-linecap': 'round' }),

  witch_hat: () => ellipse(0, 20, 46, 12, solid('plum', 'plum_deep', SW_D)) +
    pathEl('M-22 20L0-56L22 20Z', solid('plum', 'plum_deep', SW_D)) +
    rrect(-22, 10, 44, 12, R.sm, solid('plum_deep', 'plum_deep', SW_H)) +
    circle(0, -44, 6, solid('gold', 'gold_deep', SW_H)),

  cauldron: () => pathEl('M-38-6Q-40 30 0 32T38-6Q24 10 0 10T-38-6Z', solid('ink', 'ink', SW_D)) +
    ellipse(0, -8, 34, 10, solid('leafy', 'leafy_deep', SW_H)) +
    circle(-30, -10, 5, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H }) + circle(30, -10, 5, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H }) +
    circle(-6, -20, 3, solid('leafy', 'leafy_deep', SW_H)) + circle(8, -24, 2.4, solid('leafy', 'leafy_deep', SW_H)),

  candy_corn: () => pathEl('M-20-40Q0-50 20-40L10 30Q0 42-10 30Z', solid('white', 'white_deep', SW_H)) +
    pathEl('M-16-18L16-18L12 10Q0 18-12 10Z', solid('sun', 'sun_deep', SW_H)) +
    pathEl('M-12 10L12 10L10 30Q0 42-10 30Z', solid('red', 'red_deep', SW_H)),

  jack_lantern: () => ellipse(0, -21, 43, 29, solid('sun', 'sun_deep', SW_D)) +
    rrect(-5, -59, 10, 14, R.sm, solid('leafy', 'leafy_deep', SW_H)) +
    pathEl('M-18-32l8 10-8 10zM18-32l-8 10 8 10z', solid('ink', 'ink', SW_H)) +
    pathEl('M-20-2l6 10 6-10 6 10 6-10 6 10', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D, 'stroke-linecap': 'round' }),

  // ---- bonfire-night ----
  bonfire: () => pathEl('M-30 10l50-8M-24 16l54-6', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M0 8Q-18-10-6-34Q-2-20 4-26Q2-8 14-6Q20-16 10-34Q26-14 14 8Q22 10 0 8Z', solid('sun', 'red_deep', SW_D)) +
    pathEl('M-6-14Q0-24 6-14', { fill: 'none', stroke: c('sun_deep'), 'stroke-width': SW_H }),

  sparkler: () => pathEl('M0 40V-10', solid('metal', 'metal_deep', SW_D)) +
    [0, 45, 90, 135, 180, 225, 270, 315].map((a) => { const r = a * Math.PI / 180; return pathEl(`M0 -10L${n(Math.cos(r) * 22)} ${n(-10 + Math.sin(r) * 22)}`, line('gold_deep', SW_H)); }).join('') +
    circle(0, -10, 5, solid('gold', 'gold_deep', SW_H)),

  toffee_apple: () => pathEl('M0 -4q-24-4-20-28q4-18 20-14q16-4 20 14q4 24-20 28z', solid('red', 'red_deep', SW_D)) +
    pathEl('M0 24V48', solid('wood', 'wood_deep', SW_D)) +
    ellipse(-8, -20, 5, 7, { fill: c('white'), opacity: 0.4, stroke: 'none' }),

  bobble_hat: () => pathEl('M-32 10Q-34-34 0-38T32 10Z', solid('berry', 'berry_deep', SW_D)) +
    rrect(-32, 4, 64, 16, R.sm, solid('berry_deep', 'berry_deep', SW_H)) +
    circle(0, -46, 12, solid('white', 'white_deep', SW_H)),

  // ---- diwali ----
  rangoli: () => {
    const cols = ['red', 'sun', 'petal', 'leafy'];
    let m = '';
    for (let i = 0; i < 8; i++) {
      const col = cols[i % 4];
      m += group(ellipse(0, -22, 10, 16, solid(col, `${col}_deep`, SW_H)), { transform: `rotate(${n(i * 45)})` });
    }
    return m + circle(0, 0, 10, solid('sun', 'sun_deep', SW_H)) + circle(0, 0, 38, { fill: 'none', stroke: c('gold_deep'), 'stroke-width': SW_H });
  },

  sweet_ladoo: () => circle(0, 0, 32, solid('sun', 'sun_deep', SW_D)) +
    [[-10, -10], [10, -8], [0, 8], [-14, 8], [12, 10]].map(([x, y]) => circle(n(x), n(y), 3, { fill: c('sun_deep'), opacity: 0.5, stroke: 'none' })).join(''),

  marigold_garland: () => pathEl('M-40 -8Q0 10 40 -8', line('leafy_deep', SW_H)) +
    [[-40, -8], [-20, 2], [0, 8], [20, 2], [40, -8]].map(([x, y]) => circle(n(x), n(y), 11, solid('sun', 'sun_deep', SW_H))).join(''),

  // Shared Diwali / around-the-world decorative pattern — a dotted
  // concentric motif, deliberately abstract (no script, no deity, no
  // building outline) so it reads as "a pattern", never a specific symbol.
  mandala_pattern: () => {
    let m = circle(0, 0, 40, { fill: 'none', stroke: c('gold_deep'), 'stroke-width': SW_H });
    for (let i = 0; i < 12; i++) { const a = i / 12 * 2 * Math.PI; m += circle(n(Math.cos(a) * 40), n(Math.sin(a) * 40), 4, solid('berry', 'berry_deep', SW_H)); }
    m += circle(0, 0, 22, { fill: 'none', stroke: c('leafy_deep'), 'stroke-width': SW_H });
    for (let i = 0; i < 8; i++) { const a = i / 8 * 2 * Math.PI; m += circle(n(Math.cos(a) * 22), n(Math.sin(a) * 22), 3, solid('sun', 'sun_deep', SW_H)); }
    return m + circle(0, 0, 6, solid('red', 'red_deep', SW_H));
  },

  // ---- remembrance (gentle, no weapons/battle) ----
  wreath: () => {
    let m = '';
    for (let i = 0; i < 14; i++) m += group(ellipse(0, -30, 9, 16, solid('leafy', 'leafy_deep', SW_H)), { transform: `rotate(${n(i * (360 / 14))})` });
    return m + pathEl('M-10 32l10-8 10 8-4-12 4-12-10 8-10-8 4 12z', solid('red', 'red_deep', SW_H));
  },

  dove: () => ellipse(4, 2, 26, 14, solid('white', 'white_deep', SW_D)) +
    pathEl('M-6-4Q-40-24-14-6Q-30-2-2 4Z', solid('white', 'white_deep', SW_D)) +
    circle(26, -4, 9, solid('white', 'white_deep', SW_H)) +
    pathEl('M34-6l10-2-6 8z', solid('sand', 'sand_deep', SW_H)) +
    circle(30, -6, 1.8, { fill: c('ink'), stroke: 'none' }),

  medal: () => pathEl('M-14-50l14 34 14-34', solid('red', 'red_deep', SW_D)) +
    circle(0, 10, 26, solid('gold', 'gold_deep', SW_D)) +
    pathEl('M0 -4l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z', solid('gold_deep', 'gold_deep', SW_H)),

  // A quiet reflection bench (also used by sports/park contexts).
  bench: () => rrect(-44, -8, 88, 10, R.sm, solid('wood', 'wood_deep', SW_D)) +
    rrect(-44, 6, 88, 8, R.sm, solid('wood', 'wood_deep', SW_H)) +
    pathEl('M-36 14V28M36 14V28', { fill: 'none', stroke: c('wood_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' }),

  clock: () => circle(0, 0, 36, solid('white', 'white_deep', SW_D)) +
    [0, 90, 180, 270].map((a) => { const r = a * Math.PI / 180; return pathEl(`M${n(Math.cos(r) * 30)} ${n(Math.sin(r) * 30)}L${n(Math.cos(r) * 34)} ${n(Math.sin(r) * 34)}`, line('ink', SW_H)); }).join('') +
    pathEl('M0 0L0-20', line('ink', SW_D)) + pathEl('M0 0L14 6', line('ink', SW_H)) +
    circle(0, 0, 3, { fill: c('ink'), stroke: 'none' }),

  // ---- hanukkah ----
  dreidel: () => pathEl('M-22-30h44v40l-22 30-22-30z', solid('berry', 'berry_deep', SW_D)) +
    pathEl('M-22-30h44', line('berry_deep', SW_H)) +
    pathEl('M-8-14q8 6 16 0', { fill: 'none', stroke: c('gold'), 'stroke-width': SW_H }),

  // A respectful, purely geometric hexagram outline — no script, no figure.
  star_of_david: () => pathEl('M0-36L31 18H-31Z', { fill: 'none', stroke: c('water_deep'), 'stroke-width': SW_D, 'stroke-linejoin': 'round' }) +
    pathEl('M0 36L-31-18H31Z', { fill: 'none', stroke: c('water_deep'), 'stroke-width': SW_D, 'stroke-linejoin': 'round' }),

  gelt_coin: () => circle(0, 0, 30, solid('gold', 'gold_deep', SW_D)) +
    circle(0, 0, 22, { fill: 'none', stroke: c('gold_deep'), 'stroke-width': SW_H }) +
    circle(0, 0, 8, solid('gold_deep', 'gold_deep', SW_H)),

  latke: () => ellipse(0, 4, 34, 14, solid('wood', 'wood_deep', SW_D)) +
    ellipse(0, -6, 16, 8, solid('white', 'white_deep', SW_H)) +
    [[-8, 0], [6, 2], [-2, 8]].map(([x, y]) => circle(n(x), n(y), 2.2, { fill: c('wood_deep'), opacity: 0.5, stroke: 'none' })).join(''),

  // ---- lunar new year ----
  // A friendly dragon-dance head — no teeth bared, a curling mane and
  // whiskers, not a fierce creature.
  dragon: () => pathEl('M-40 10Q-44-20-10-24Q0-34 20-24Q46-14 30 10Q10 2-10 6Q-26 10-40 10Z', solid('red', 'red_deep', SW_D)) +
    pathEl('M20-24q10-14 22-8q-4 10-14 14z', solid('gold', 'gold_deep', SW_H)) +
    pathEl('M-6-24q-4-12 6-16q2 10-2 16z', solid('gold', 'gold_deep', SW_H)) +
    circle(16, -6, 4, { fill: c('ink'), stroke: 'none' }) +
    pathEl('M34 6l10 2M34 12l10 6', line('gold_deep', SW_H)),

  dumpling: () => pathEl('M-30 6Q-30-14 0-16T30 6Q16 16 0 16T-30 6Z', solid('white', 'white_deep', SW_D)) +
    pathEl('M-14-14q4 6 0 10M-2-16q4 6 0 10M10-14q4 6 0 10', line('white_deep', SW_H)),

  // ---- christmas / winter ----
  robin: () => circle(0, 10, 24, solid('earth', 'earth_deep', SW_D)) +
    circle(16, -10, 16, solid('earth', 'earth_deep', SW_D)) +
    ellipse(2, 6, 14, 16, solid('red', 'red_deep', SW_H)) +
    pathEl('M30-10l12 4-12 6z', solid('sand', 'sand_deep', SW_H)) +
    circle(22, -14, 2.6, { fill: c('ink'), stroke: 'none' }),

  stocking: () => pathEl('M-20-40h30v30q24 0 24 24t-24 20h-30q-14 0-14-14v-40q0-20 14-20z', solid('red', 'red_deep', SW_D)) +
    rrect(-20, -50, 30, 14, R.sm, solid('white', 'white_deep', SW_H)) +
    circle(18, 20, 6, solid('white', 'white_deep', SW_H)),

  holly: () => {
    const leaf = (rot) => group(pathEl('M0-30q14 10 10 26q-10 8-10 8q0 0-10-8q-4-16 10-26z', solid('leafy', 'leafy_deep', SW_H)), { transform: `rotate(${n(rot)})` });
    return leaf(-24) + leaf(0) + leaf(24) + circle(-8, 10, 6, solid('red', 'red_deep', SW_H)) + circle(6, 12, 6, solid('red', 'red_deep', SW_H)) + circle(0, 20, 6, solid('red', 'red_deep', SW_H));
  },

  // ---- nursery rhymes ----
  mouse: () => pathEl('M30 14q16 2 20-6q-10 0-14-6z', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H }) +
    ellipse(0, 8, 30, 20, solid('metal', 'metal_deep', SW_D)) +
    circle(22, -8, 16, solid('metal', 'metal_deep', SW_D)) +
    circle(8, -26, 9, solid('metal', 'metal_deep', SW_H)) + circle(26, -26, 9, solid('metal', 'metal_deep', SW_H)) +
    ellipse(30, -4, 5, 6, solid('petal', 'petal_deep', SW_H)) +
    circle(28, -12, 2.4, { fill: c('ink'), stroke: 'none' }),

  // ---- dinosaurs (brief: at least 6 genuinely different species) ----
  // A three-horned face with a wide back frill — triceratops. Redrawn
  // (Claude review 2026-10-03): the first pass's horns were thin hairlines
  // and the frill barely read. Now: a big solid fan-shaped frill BEHIND a
  // round head drawn IN FRONT of it, three solid filled triangular horns
  // (two brow horns + one nose horn) big enough to read at icon size.
  // o.key recolours.
  triceratops: (o = {}) => {
    const key = o.key || 'earth';
    return ellipse(8, -8, 50, 42, solid(key, `${key}_deep`, SW_D)) +
      ellipse(-8, 32, 42, 24, solid(key, `${key}_deep`, SW_D)) +
      ellipse(-32, 54, 10, 7, solid(`${key}_deep`, `${key}_deep`, SW_H)) + ellipse(0, 54, 10, 7, solid(`${key}_deep`, `${key}_deep`, SW_H)) +
      circle(-4, -2, 26, solid(key, `${key}_deep`, SW_D)) +
      pathEl('M-8-26l-12-22 18 8z', solid(key, `${key}_deep`, SW_H)) +
      pathEl('M12-24l6-22 14 14z', solid(key, `${key}_deep`, SW_H)) +
      pathEl('M16 2l22-6-10 20z', solid(key, `${key}_deep`, SW_H)) +
      circle(8, -6, 3.2, { fill: c('ink'), stroke: 'none' });
  },

  // A row of back plates — stegosaurus. o.key recolours.
  stegosaurus: (o = {}) => {
    const key = o.key || 'leafy';
    return pathEl('M-50 24Q-54 0-20 2Q0-6 30 0Q50 2 50 20Q30 12-10 14Q-34 16-50 24Z', solid(key, `${key}_deep`, SW_D)) +
      [-28, -10, 8, 26].map((x) => pathEl(`M${n(x)} -4L${n(x - 8)} -30L${n(x + 8)} -30Z`, solid(key, `${key}_deep`, SW_H))).join('') +
      circle(44, 6, 10, solid(key, `${key}_deep`, SW_H)) +
      circle(50, 2, 2.6, { fill: c('ink'), stroke: 'none' }) +
      pathEl('M-50 24q-10 6-16 0', { fill: 'none', stroke: c(`${key}_deep`), 'stroke-width': 7, 'stroke-linecap': 'round' });
  },

  // A BIG-headed two-armed predator — T-rex-style, toddler-friendly (an
  // open jaw with a few blunt teeth, never bared/sharp). Redrawn (Claude
  // review 2026-10-03): the first pass was the same rounded-blob silhouette
  // as the base `dinosaur` prop, just recoloured — not a different species.
  // Now the head is bigger than the body (T-rex's defining proportion) with
  // a visible open jaw, and a short body with a thick tail balances it.
  // o.key recolours.
  trex: (o = {}) => {
    const key = o.key || 'berry';
    return pathEl('M-56 40Q-70 16-36 6', { fill: 'none', stroke: c(`${key}_deep`), 'stroke-width': 14, 'stroke-linecap': 'round' }) +
      ellipse(-16, 32, 32, 24, solid(key, `${key}_deep`, SW_D)) +
      ellipse(-34, 56, 9, 6, solid(`${key}_deep`, `${key}_deep`, SW_H)) + ellipse(-6, 56, 9, 6, solid(`${key}_deep`, `${key}_deep`, SW_H)) +
      pathEl('M6-8q-8-2-6 8', { fill: 'none', stroke: c(`${key}_deep`), 'stroke-width': 7, 'stroke-linecap': 'round' }) +
      circle(26, -14, 32, solid(key, `${key}_deep`, SW_D)) +
      pathEl('M2-6Q40-6 56 8Q40 20 2 14Z', solid(`${key}_deep`, `${key}_deep`, SW_H)) +
      pathEl('M10-4l3 7M20-6l3 7M30-7l3 7', { fill: 'none', stroke: c('white'), 'stroke-width': 2.6, 'stroke-linecap': 'round' }) +
      circle(28, -26, 3.2, { fill: c('ink'), stroke: 'none' });
  },

  // A flying reptile, wings spread wide in a clear M-shape either side of a
  // visible head and beak — pterosaur. Redrawn (Claude review 2026-10-03):
  // the first pass read as a bowtie/ribbon with no head. o.key recolours.
  pterosaur: (o = {}) => {
    const key = o.key || 'sand';
    return pathEl('M0 8Q-70-24-34 4Q-50 10-10 14Q0 10 0 8Z', solid(key, `${key}_deep`, SW_D)) +
      pathEl('M0 8Q70-24 34 4Q50 10 10 14Q0 10 0 8Z', solid(key, `${key}_deep`, SW_D)) +
      circle(0, -8, 18, solid(key, `${key}_deep`, SW_D)) +
      pathEl('M14-10q18-8 28 0q-10 8-28 2z', solid(key, `${key}_deep`, SW_H)) +
      pathEl('M-6-26q-4-12 6-16q4 12-6 16z', solid(key, `${key}_deep`, SW_H)) +
      circle(6, -12, 2.6, { fill: c('ink'), stroke: 'none' });
  },

  // ---- easter / spring ----
  easter_bonnet: () => ellipse(0, 18, 48, 12, solid('sand', 'sand_deep', SW_D)) +
    pathEl('M-26 18Q-30-14 0-16T26 18Z', solid('sand', 'sand_deep', SW_D)) +
    pathEl('M-26 10Q0 20 26 10', line('petal_deep', SW_H)) +
    circle(-10, 6, 6, solid('petal', 'petal_deep', SW_H)) + circle(6, 2, 6, solid('sun', 'sun_deep', SW_H)),

  lamb: () => {
    let fluff = '';
    for (let i = 0; i < 6; i++) fluff += circle(n(-24 + i * 10), -10, 13, solid('white', 'white_deep', SW_H));
    return fluff + ellipse(0, 6, 32, 18, solid('white', 'white_deep', SW_D)) +
      circle(30, -6, 16, solid('sand', 'sand_deep', SW_D)) +
      circle(26, -10, 2.6, { fill: c('ink'), stroke: 'none' }) +
      ellipse(0, 26, 8, 6, solid('sand', 'sand_deep', SW_H)) + ellipse(16, 26, 8, 6, solid('sand', 'sand_deep', SW_H));
  },

  daffodil: () => {
    let petals = '';
    for (let i = 0; i < 6; i++) petals += group(ellipse(0, -20, 10, 16, solid('sun', 'sun_deep', SW_H)), { transform: `rotate(${n(i * 60)})` });
    return pathEl('M0 30V60', line('leafy_deep', SW_D)) + petals + circle(0, 0, 12, solid('gold', 'gold_deep', SW_H));
  },

  // ---- settling-in / leavers (comfort object, reused by both) ----
  teddy_bear: () => circle(0, 10, 30, solid('wood', 'wood_deep', SW_D)) +
    circle(0, -22, 22, solid('wood', 'wood_deep', SW_D)) +
    circle(-18, -38, 10, solid('wood', 'wood_deep', SW_H)) + circle(18, -38, 10, solid('wood', 'wood_deep', SW_H)) +
    ellipse(0, -16, 10, 8, solid('sand', 'sand_deep', SW_H)) +
    circle(-10, -26, 2.6, { fill: c('ink'), stroke: 'none' }) + circle(10, -26, 2.6, { fill: c('ink'), stroke: 'none' }) +
    circle(0, -14, 3, { fill: c('ink'), stroke: 'none' }) +
    ellipse(-24, 16, 9, 7, solid('wood', 'wood_deep', SW_H)) + ellipse(24, 16, 9, 7, solid('wood', 'wood_deep', SW_H)),

  // ---- pets ----
  hamster: () => ellipse(0, 6, 32, 26, solid('sand', 'sand_deep', SW_D)) +
    circle(-16, -18, 9, solid('sand', 'sand_deep', SW_H)) + circle(10, -20, 9, solid('sand', 'sand_deep', SW_H)) +
    cheek(-14, 8, 1.3) + cheek(14, 8, 1.3) +
    circle(-6, -4, 2.6, { fill: c('ink'), stroke: 'none' }) + circle(10, -6, 2.6, { fill: c('ink'), stroke: 'none' }),

  guinea_pig: () => ellipse(0, 4, 40, 24, solid('earth', 'earth_deep', SW_D)) +
    ellipse(-30, -6, 14, 14, solid('white', 'white_deep', SW_H)) +
    circle(-40, 2, 2.4, { fill: c('ink'), stroke: 'none' }) +
    ellipse(18, 16, 10, 7, solid('earth_deep', 'earth_deep', SW_H)) + ellipse(34, 16, 10, 7, solid('earth_deep', 'earth_deep', SW_H)),

  tortoise: () => {
    const hex = [[-16, -8], [16, -8], [0, 0], [-16, 10], [16, 10]];
    return ellipse(0, 0, 42, 30, solid('leafy', 'leafy_deep', SW_D)) +
      hex.map(([x, y]) => circle(n(x), n(y), 9, { fill: 'none', stroke: c('leafy_deep'), 'stroke-width': SW_H })).join('') +
      circle(44, 6, 12, solid('leafy', 'leafy_deep', SW_D)) + circle(50, 2, 2.2, { fill: c('ink'), stroke: 'none' }) +
      ellipse(-30, 22, 7, 5, solid('leafy_deep', 'leafy_deep', SW_H)) + ellipse(-4, 26, 7, 5, solid('leafy_deep', 'leafy_deep', SW_H));
  },

  // ---- construction ----
  digger: () => rrect(-40, -10, 60, 28, R.sm, solid('sun', 'sun_deep', SW_D)) +
    circle(-26, 18, 12, solid('metal_deep', 'metal_deep', SW_H)) + circle(6, 18, 12, solid('metal_deep', 'metal_deep', SW_H)) +
    pathEl('M10-10Q40-30 54-10', { fill: 'none', stroke: c('sun_deep'), 'stroke-width': 9, 'stroke-linecap': 'round' }) +
    pathEl('M54-10l10 14-20 4z', solid('metal', 'metal_deep', SW_H)),

  crane: () => rrect(-8, -20, 16, 60, R.sm, solid('metal', 'metal_deep', SW_D)) +
    pathEl('M0-20L54-34', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D }) +
    pathEl('M0-20L-30-10', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H }) +
    pathEl('M50-34V2', line('ink', SW_H)) +
    rrect(44, 2, 12, 10, R.sm, solid('sun', 'sun_deep', SW_H)),

  traffic_cone: () => pathEl('M-8-50h16l22 70h-60z', solid('sun', 'sun_deep', SW_D)) +
    rrect(-22, 0, 44, 12, 0, solid('white', 'white_deep', SW_H)) +
    rrect(-30, 20, 60, 10, R.sm, solid('sun_deep', 'sun_deep', SW_H)),

  hard_hat: () => pathEl('M-36 8Q-40-32 0-34T36 8Z', solid('sun', 'sun_deep', SW_D)) +
    rrect(-40, 4, 80, 12, R.sm, solid('sun_deep', 'sun_deep', SW_H)) +
    pathEl('M0-34V-44', line('sun_deep', SW_H)),

  wheelbarrow: () => circle(-28, 20, 14, solid('metal_deep', 'metal_deep', SW_D)) +
    pathEl('M-14 0h50l-8 24h-42z', solid('sun', 'sun_deep', SW_D)) +
    pathEl('M36 0l14-4M36 20l14 4', line('wood_deep', SW_H)),

  nail: () => pathEl('M-4-40h8v10h-8z', solid('metal', 'metal_deep', SW_H)) +
    pathEl('M0-30V30', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': 8, 'stroke-linecap': 'round' }) +
    pathEl('M-10 30l10 14 10-14z', solid('metal', 'metal_deep', SW_H)),

  // ---- transport ----
  plane: () => pathEl('M-50 0h100l-14 10h-24l-8 14-6-14h-34z', solid('sky', 'sky_deep', SW_D)) +
    pathEl('M-10-4l0-20 14 14z', solid('sky', 'sky_deep', SW_H)) +
    circle(34, 0, 4, solid('white', 'white_deep', SW_H)),

  bicycle: () => circle(-28, 16, 20, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D }) +
    circle(28, 16, 20, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D }) +
    pathEl('M-28 16L0-14L28 16M0-14L-10-14M-28 16L10-2L28 16', { fill: 'none', stroke: c('red_deep'), 'stroke-width': SW_H }) +
    rrect(-16, -20, 12, 6, R.sm, solid('red', 'red_deep', SW_H)),

  helicopter: () => ellipse(0, 10, 40, 20, solid('red', 'red_deep', SW_D)) +
    rrect(-50, 6, 16, 8, R.sm, solid('red', 'red_deep', SW_H)) +
    pathEl('M0-14V-24', line('metal_deep', SW_D)) +
    pathEl('M-40-24h80', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H }) +
    circle(44, 16, 10, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H }),

  // A fire engine — also doubles for people-who-help-us contexts.
  fire_engine: () => rrect(-44, -14, 88, 30, R.sm, solid('red', 'red_deep', SW_D)) +
    rrect(20, -30, 24, 16, R.sm, solid('red', 'red_deep', SW_H)) +
    circle(-26, 20, 12, solid('metal_deep', 'metal_deep', SW_H)) + circle(18, 20, 12, solid('metal_deep', 'metal_deep', SW_H)) +
    pathEl('M-40-14h80', { fill: 'none', stroke: c('gold'), 'stroke-width': SW_H }),

  scooter: () => pathEl('M-30 20h50L34-10', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D }) +
    pathEl('M34-10V-30', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_D }) +
    pathEl('M24-30h20', { fill: 'none', stroke: c('red_deep'), 'stroke-width': 7, 'stroke-linecap': 'round' }) +
    circle(-28, 24, 8, solid('ink', 'ink', SW_H)) + circle(18, 24, 8, solid('ink', 'ink', SW_H)),

  // ---- farm ----
  sheep: () => {
    let fluff = '';
    for (let i = 0; i < 7; i++) fluff += circle(n(-30 + i * 10), -12, 15, solid('white', 'white_deep', SW_H));
    return fluff + ellipse(0, 8, 38, 22, solid('white', 'white_deep', SW_D)) +
      circle(38, -4, 18, solid('ink', 'ink', SW_D)) +
      pathEl('M24-16q-10-6-16 2M52-16q10-6 16 2', solid('ink', 'ink', SW_H)) +
      circle(34, -8, 2.6, { fill: c('white'), stroke: 'none' }) +
      ellipse(-10, 30, 9, 7, solid('ink', 'ink', SW_H)) + ellipse(14, 30, 9, 7, solid('ink', 'ink', SW_H));
  },

  horse: () => {
    const leg = (x, topY) => rrect(n(x - 7), n(topY), 14, n(-topY), R.sm, solid('earth', 'earth_deep', SW_D));
    const hx = 70, hy = -70;
    return leg(-44, -14) + leg(-20, -16) + leg(26, -14) + leg(46, -16) +
      ellipse(0, -46, 60, 34, solid('earth', 'earth_deep', SW_D)) +
      pathEl(`M${n(hx - 30)} ${n(hy + 20)}Q${n(hx - 10)} ${n(hy - 10)} ${n(hx)} ${n(hy - 30)}`, { fill: 'none', stroke: c('earth_deep'), 'stroke-width': SW_D }) +
      circle(hx, hy, 24, solid('earth', 'earth_deep', SW_D)) +
      pathEl(`M${n(hx - 6)} ${n(hy - 20)}q-10-20 4-26q10 6 6 26z`, solid('wood', 'wood_deep', SW_H)) +
      pathEl(`M${n(hx + 16)} ${n(hy + 2)}q16 2 20 12q-14 2-22-4z`, solid('wood', 'wood_deep', SW_H)) +
      eye(n(hx + 4), n(hy - 6), 'open', 0.9, 'earth');
  },

  scarecrow: () => pathEl('M-30 40L30-10M30 40L-30-10', { fill: 'none', stroke: c('wood_deep'), 'stroke-width': 8, 'stroke-linecap': 'round' }) +
    circle(0, -40, 24, solid('sand', 'sand_deep', SW_D)) +
    rrect(-26, -66, 52, 16, R.sm, solid('sun', 'sun_deep', SW_H)) +
    pathEl('M-10-44l-4 6M10-44l4 6', line('ink', SW_H)) +
    pathEl('M-8-30q8 6 16 0', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H }),

  // ---- jungle-and-safari (brief: genuinely different species) ----
  giraffe: () => ellipse(-6, -24, 26, 20, solid('sand', 'sand_deep', SW_D)) +
    rrect(-26, -14, 12, 24, R.sm, solid('sand', 'sand_deep', SW_D)) + rrect(-6, -14, 12, 24, R.sm, solid('sand', 'sand_deep', SW_D)) +
    pathEl('M4-38Q8-80 24-96', { fill: 'none', stroke: c('sand_deep'), 'stroke-width': 20, 'stroke-linecap': 'round' }) +
    circle(28, -100, 16, solid('sand', 'sand_deep', SW_D)) +
    pathEl('M20-114l-2-8M34-114l2-8', { fill: 'none', stroke: c('sand_deep'), 'stroke-width': SW_H, 'stroke-linecap': 'round' }) +
    [[-4, -20], [10, -30], [-14, -10], [6, -60], [18, -80]].map(([x, y]) => ellipse(n(x), n(y), 6, 5, solid('earth', 'earth_deep', SW_H))).join('') +
    eye(34, -102, 'open', 0.7, 'sand'),

  zebra: () => {
    const leg = (x, topY) => rrect(n(x - 7), n(topY), 14, n(-topY), R.sm, solid('white', 'white_deep', SW_D));
    const hx = 60, hy = -56;
    return leg(-36, -14) + leg(-16, -16) + leg(20, -14) + leg(36, -16) +
      ellipse(0, -40, 54, 30, solid('white', 'white_deep', SW_D)) +
      circle(hx, hy, 20, solid('white', 'white_deep', SW_D)) +
      [[-30, -40], [-10, -46], [10, -36], [30, -30]].map(([x, y]) => pathEl(`M${n(x)} ${n(y)}q6 10 0 20`, line('ink', SW_H))).join('') +
      pathEl(`M${n(hx - 4)} ${n(hy - 14)}q-10-10 0-16q8 6 4 16z`, solid('ink', 'ink', SW_H)) +
      eye(n(hx + 6), n(hy - 4), 'open', 0.8, 'white');
  },

  snake: () => pathEl('M-40 20Q-40-20 0-10T40 10', { fill: 'none', stroke: c('leafy_deep'), 'stroke-width': 20, 'stroke-linecap': 'round' }) +
    circle(46, 8, 14, solid('leafy', 'leafy_deep', SW_D)) +
    pathEl('M60 8l12-4-4 6 4 6-12-4z', { fill: 'none', stroke: c('red_deep'), 'stroke-width': SW_H }) +
    circle(50, 2, 2.4, { fill: c('ink'), stroke: 'none' }),

  tiger: () => circle(0, 0, 34, solid('sun', 'sun_deep', SW_D)) +
    circle(-26, -20, 12, solid('sun', 'sun_deep', SW_H)) + circle(26, -20, 12, solid('sun', 'sun_deep', SW_H)) +
    ellipse(0, 10, 16, 12, solid('white', 'white_deep', SW_H)) +
    [[-20, -14], [-24, 4], [20, -14], [24, 4]].map(([x, y]) => pathEl(`M${n(x)} ${n(y)}l-6 8`, line('ink', SW_H))).join('') +
    circle(-10, -4, 3, { fill: c('ink'), stroke: 'none' }) + circle(10, -4, 3, { fill: c('ink'), stroke: 'none' }) +
    pathEl('M0 6l-6 8h12z', solid('sand', 'sand_deep', SW_H)),

  crocodile: () => pathEl('M-50 10Q-50-8-20-6Q0-16 30-8Q52-4 50 8Q30 2 0 4Q-24 6-50 10Z', solid('leafy', 'leafy_deep', SW_D)) +
    [[-6, -10], [8, -12], [22, -10]].map(([x, y]) => pathEl(`M${n(x)} ${n(y)}l-6-8 12 0z`, solid('leafy', 'leafy_deep', SW_H))).join('') +
    pathEl('M30-8q14-2 22 2q-8 6-20 4z', solid('leafy', 'leafy_deep', SW_D)) +
    pathEl('M34-8l4-6M40-6l4-6M46-4l4-6', line('white_deep', SW_H)) +
    circle(16, -14, 2.6, { fill: c('ink'), stroke: 'none' }),

  // ---- seaside-summer ----
  shell: () => pathEl('M0 30Q-30 30-30-4Q-30-34 0-34Q26-34 26-10Q26 6 6 6Q-6 6-6-6Q-6-14 2-14', { fill: 'none', stroke: c('petal_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' }) +
    [0, 10, 20].map((y) => pathEl(`M${n(-24 + y * 0.2)} ${n(26 - y)}Q0 ${n(10 - y * 0.6)} ${n(20 - y * 0.3)} ${n(2 - y * 0.2)}`, line('petal_deep', SW_H))).join(''),

  starfish: () => {
    let arm = '';
    for (let i = 0; i < 5; i++) arm += group(pathEl('M0 0Q-10 20 0 40Q10 20 0 0Z', solid('petal', 'petal_deep', SW_H)), { transform: `rotate(${n(i * 72)})` });
    return arm + circle(0, 0, 10, solid('petal', 'petal_deep', SW_D));
  },

  // ---- harvest / traditional-tales / easter / pets (shared basket) ----
  basket: () => pathEl('M-36 0l10 30h52l10-30z', solid('wood', 'wood_deep', SW_D)) +
    pathEl('M-36 0h72', line('wood_deep', SW_H)) +
    pathEl('M-28-6q0-26 28-26t28 26', { fill: 'none', stroke: c('wood_deep'), 'stroke-width': SW_D }) +
    pathEl('M-24 6h48M-20 16h40', line('wood_deep', SW_H)),

  carrot: () => pathEl('M-14-20q14-4 28 0l-8 50q-6 10-12 0z', solid('sun', 'sun_deep', SW_D)) +
    pathEl('M-4-20q-8-14 0-22M4-20q8-14 0-22M-10-20q-10-10-4-20', { fill: 'none', stroke: c('leafy_deep'), 'stroke-width': SW_H, 'stroke-linecap': 'round' }),

  // ---- growing ----
  sunflower: () => {
    let petals = '';
    for (let i = 0; i < 10; i++) petals += group(ellipse(0, -30, 9, 16, solid('sunflower', 'sunflower_deep', SW_H)), { transform: `rotate(${n(i * 36)})` });
    return pathEl('M0 30V70', line('leafy_deep', SW_D)) + petals + circle(0, 0, 16, solid('wood', 'wood_deep', SW_H));
  },

  // ---- sports ----
  whistle: () => pathEl('M-30 0q0-14 14-14h20q14 0 14 14t-14 14h-20q-14 0-14-14z', solid('metal', 'metal_deep', SW_D)) +
    circle(16, 0, 5, { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H }) +
    pathEl('M-30 0q-16 10-10 26', { fill: 'none', stroke: c('wood_deep'), 'stroke-width': SW_H }),

  skipping_rope: () => pathEl('M-40-10Q0 50 40-10', { fill: 'none', stroke: c('red_deep'), 'stroke-width': SW_D, 'stroke-linecap': 'round' }) +
    rrect(-48, -22, 14, 24, R.sm, solid('wood', 'wood_deep', SW_H)) +
    rrect(34, -22, 14, 24, R.sm, solid('wood', 'wood_deep', SW_H)),

  beanbag: () => rrect(-26, -20, 52, 40, R.md, solid('petal', 'petal_deep', SW_D)) +
    pathEl('M-26-20l10 10M26-20l-10 10M-26 20l10-10M26 20l-10-10', line('petal_deep', SW_H)),

  // ---- people-who-help-us ----
  // One flexible standing-person prop: o.skin (varied skin tones) + o.role
  // (uniform colour + a small role accessory). Keeps every helper the same
  // simple build, so "which job" reads from the accessory, not a redesign.
  helper_person: (o = {}) => {
    const skin = o.skin || 'sand';
    // o.skinStroke (b392 fix): sand/earth/wood are near-identical hexes, so
    // three "varied skin tones" rendered that way were barely distinguishable
    // (Claude review 2026-10-03). Picture-bank entries now span sand (light),
    // hedgehog (mid), and wood_deep (deep, paired with an ink stroke rather
    // than a nonexistent 'wood_deep_deep' token) for real visible contrast.
    const skinStroke = o.skinStroke || `${skin}_deep`;
    const role = o.role || 'nurse';
    const ROLE_COLOR = { nurse: 'sky', doctor: 'white', vet: 'leafy', postal: 'red', refuse: 'sun', lollipop: 'gold', firefighter: 'red', police: 'metal' };
    const top = ROLE_COLOR[role] || 'sky';
    const hx = 0, hy = -70;
    let accessory = '';
    if (role === 'nurse') accessory = rrect(-40, -96, 24, 24, R.sm, solid('white', 'white_deep', SW_H)) + pathEl('M-32-90v12M-38-84h12', { fill: 'none', stroke: c('red_deep'), 'stroke-width': SW_H });
    else if (role === 'doctor') accessory = pathEl('M-14-30q-16 6-16 20q0 10 10 10', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H }) + circle(-20, 0, 6, { fill: 'none', stroke: c('metal_deep'), 'stroke-width': SW_H });
    else if (role === 'vet') accessory = ellipse(26, -20, 10, 8, solid('earth', 'earth_deep', SW_H)) + circle(26, -20, 3, { fill: c('ink'), opacity: 0.3, stroke: 'none' });
    else if (role === 'postal') accessory = rrect(-34, -20, 24, 30, R.sm, solid('red', 'red_deep', SW_H));
    else if (role === 'refuse') accessory = rrect(-34, -22, 26, 32, R.sm, solid('leafy', 'leafy_deep', SW_H));
    else if (role === 'lollipop') accessory = pathEl('M30-100V-20', line('wood_deep', SW_D)) + circle(30, -108, 16, solid('sun', 'sun_deep', SW_H));
    else if (role === 'firefighter') accessory = pathEl('M-32-90q-4-28 32-32t32 32', solid('red', 'red_deep', SW_D)) + circle(0, -96, 8, solid('gold', 'gold_deep', SW_H));
    else if (role === 'police') accessory = rrect(-30-6, -102, 60, 14, R.sm, solid('ink', 'ink', SW_D)) + circle(0, -98, 6, solid('gold', 'gold_deep', SW_H));
    return ellipse(0, 20, 28, 30, solid(top, `${top}_deep`, SW_D)) +
      circle(hx, hy, 26, solid(skin, skinStroke, SW_D)) +
      eye(hx + 4, hy - 2, 'open', 0.85, skin) +
      accessory +
      ellipse(-20, 54, 9, 7, solid(skin, skinStroke, SW_H)) + ellipse(20, 54, 9, 7, solid(skin, skinStroke, SW_H));
  },

  // ---- space ----
  comet: () => pathEl('M0 0Q-50-10-30 6Q-44 10-10 10Q0 14 10 10Q-10 2 0 0Z', solid('sky', 'sky_deep', SW_H)) +
    circle(16, 2, 14, solid('sky', 'sky_deep', SW_D)) +
    circle(12, -2, 2, { fill: c('white'), opacity: 0.6, stroke: 'none' }),

  satellite: () => rrect(-16, -16, 32, 32, R.sm, solid('metal', 'metal_deep', SW_D)) +
    rrect(-50, -10, 26, 20, R.sm, solid('sky', 'sky_deep', SW_H)) +
    rrect(24, -10, 26, 20, R.sm, solid('sky', 'sky_deep', SW_H)) +
    pathEl('M-16-10l-18 0M16-10l18 0', line('metal_deep', SW_H)) +
    pathEl('M0-16V-40', line('metal_deep', SW_H)) +
    circle(0, -42, 4, solid('red', 'red_deep', SW_H)),

  // ---- superheroes ----
  lightning_bolt: () => pathEl('M6-50L-14 4H2L-8 50 28-10H12Z', solid('sun', 'sun_deep', SW_D)),

  shield: () => pathEl('M0-44Q36-38 36-10Q36 30 0 50Q-36 30-36-10Q-36-38 0-44Z', solid('sky', 'sky_deep', SW_D)) +
    pathEl('M0-14l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z', solid('white', 'white_deep', SW_H)),

  // ---- world-book-day / traditional-tales ----
  wand: () => pathEl('M-20 40L20-30', { fill: 'none', stroke: c('wood_deep'), 'stroke-width': 7, 'stroke-linecap': 'round' }) +
    pathEl('M20-30l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z', solid('gold', 'gold_deep', SW_H)),

  crown: () => pathEl('M-34 20L-34-10L-14 6L0-20L14 6L34-10L34 20Z', solid('gold', 'gold_deep', SW_D)) +
    circle(-14, 2, 4, solid('red', 'red_deep', SW_H)) + circle(0, -6, 4, solid('sky', 'sky_deep', SW_H)) + circle(14, 2, 4, solid('red', 'red_deep', SW_H)) +
    rrect(-34, 20, 68, 10, R.sm, solid('gold_deep', 'gold_deep', SW_H)),

  glasses: () => circle(-22, 0, 18, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D }) +
    circle(22, 0, 18, { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D }) +
    pathEl('M-4 0h8', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D }) +
    pathEl('M-40 0l6-4M40 0l-6-4', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_H }),

  bookmark: () => pathEl('M-16-40h32v70l-16-14-16 14z', solid('berry', 'berry_deep', SW_D)),

  wolf: () => pathEl('M-20-20l-14-24 10 6zM20-20l14-24-10 6z', solid('metal', 'metal_deep', SW_D)) +
    circle(0, 0, 32, solid('metal', 'metal_deep', SW_D)) +
    pathEl('M-10 16q10 12 20 0', { fill: 'none', stroke: c('white'), 'stroke-width': SW_H }) +
    pathEl('M4 10q16 2 24 14q-10 4-18 0z', solid('white', 'white_deep', SW_H)) +
    circle(-10, -6, 3, { fill: c('ink'), stroke: 'none' }) + circle(10, -6, 3, { fill: c('ink'), stroke: 'none' }),

  giant: () => ellipse(0, 40, 40, 34, solid('earth', 'earth_deep', SW_D)) +
    circle(0, -20, 30, solid('sand', 'sand_deep', SW_D)) +
    eye(-10, -24, 'open', 1, 'sand') + eye(10, -24, 'open', 1, 'sand') +
    pathEl('M-10-4q10 8 20 0', { fill: 'none', stroke: c('ink'), 'stroke-width': SW_D }) +
    ellipse(-50, 70, 12, 9, solid('wood', 'wood_deep', SW_H)) + ellipse(50, 70, 12, 9, solid('wood', 'wood_deep', SW_H)),

  bridge: () => pathEl('M-50 10Q-50-30 0-30T50 10', { fill: 'none', stroke: c('metal_deep'), 'stroke-width': 16 }) +
    pathEl('M-50 10h100', { fill: 'none', stroke: c('wood_deep'), 'stroke-width': 8 }) +
    [-30, 0, 30].map((x) => pathEl(`M${n(x)} 10v-14`, line('metal_deep', SW_H))).join(''),

  // ---- pancake-day / food-and-cafe (shared fruit) ----
  pancake: () => ellipse(0, 20, 38, 10, solid('wood', 'wood_deep', SW_D)) +
    ellipse(0, 8, 36, 10, solid('wood', 'wood_deep', SW_D)) +
    ellipse(0, -4, 34, 10, solid('wood', 'wood_deep', SW_D)) +
    rrect(-8, -14, 16, 8, R.sm, solid('sun', 'sun_deep', SW_H)) +
    pathEl('M-20-4q4 10 0 18M10-6q4 12 0 20', line('wood_deep', SW_H)),

  lemon: () => pathEl('M0-26q22 4 22 26t-22 26-22-26 22-26z', solid('sun', 'sun_deep', SW_D)) +
    ellipse(-6, -10, 5, 7, { fill: c('white'), opacity: 0.4, stroke: 'none' }),

  strawberry: () => pathEl('M0-6q26 0 22 26q-4 22-22 22t-22-22q-4-26 22-26z', solid('red', 'red_deep', SW_D)) +
    pathEl('M-14-10q14 10 28 0M-16 2q16 8 32 0M-14 14q14 8 28 0', line('red_deep', SW_H)) +
    pathEl('M-14-10l-6-10 10 4zM14-10l6-10-10 4z', solid('leafy', 'leafy_deep', SW_H)),

  // ---- ramadan-and-eid — a respectful crescent-and-star (a purely
  // geometric motif, no script, no figure), a plate of dates, and a
  // simple dome outline. No religious text or figures anywhere.
  crescent_star: () => pathEl('M18-40Q-22-30-22 0Q-22 30 18 40Q-6 24-6 0T18-40Z', solid('gold', 'gold_deep', SW_D)) +
    pathEl('M34-10l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z', solid('gold', 'gold_deep', SW_H)),

  dates_fruit: () => ellipse(0, 4, 36, 14, solid('wood', 'wood_deep', SW_D)) +
    [-18, 0, 18].map((x) => ellipse(n(x), 2, 9, 11, solid('wood', 'wood_deep', SW_H))).join('') +
    [-18, 0, 18].map((x) => pathEl(`M${n(x)} -6q3 4 0 8`, line('wood_deep', SW_H))).join(''),

  mosque_dome: () => pathEl('M-30 20Q-34-20 0-26T30 20Z', solid('sand', 'sand_deep', SW_D)) +
    rrect(-30, 20, 60, 10, R.sm, solid('sand_deep', 'sand_deep', SW_H)) +
    pathEl('M0-26V-44', line('sand_deep', SW_H)) +
    pathEl('M8-44l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z', solid('gold', 'gold_deep', SW_H)),
};
const PROP_NAMES = Object.keys(PROPS);

/* ---------------------------------------------------------------------------
 * BACKDROPS — sky band, ground band, horizon. One per scene.
 */
const BACKDROPS = {
  plain:      { sky: 'paper', ground: null },
  garden_day: { sky: 'sky',   ground: 'grass', groundDeep: 'grass_deep' },
  earth_day:  { sky: 'sky',   ground: 'earth', groundDeep: 'earth_deep' },
  pond_day:   { sky: 'sky',   ground: 'grass', groundDeep: 'grass_deep', pond: true },
  meadow_day: { sky: 'sky',   ground: 'grass', groundDeep: 'grass_deep' },
  dusk:       { sky: 'dusk',  ground: 'grass', groundDeep: 'grass_deep', evening: true },
  // Added b382 — a dusk sky over bare soil, for night pages whose ground is
  // dug earth rather than grass (keeps the sky consistent instead of
  // switching to a daytime backdrop just because the ground is earth).
  dusk_earth: { sky: 'dusk',  ground: 'earth', groundDeep: 'earth_deep', evening: true },
  // Added b383 — a wide sea band filling the whole ground area, distinct
  // from pond_day's small side ellipse. For by-the-sea pages where the sea
  // itself is the subject; pages where the pair just sit on the sand use
  // the existing earth_day instead.
  sea_day:    { sky: 'sky',   ground: 'earth', groundDeep: 'earth_deep', sea: true },
};
const BACKDROP_NAMES = Object.keys(BACKDROPS);

function renderBackdrop(name, horizon) {
  const b = BACKDROPS[name] || BACKDROPS.garden_day;
  const y = horizon == null ? TOKENS.composition.horizon_default : horizon;
  const W = CANVAS.width, H = CANVAS.height;
  let m = rrect(0, 0, W, H, R.lg, { fill: c(b.sky), stroke: 'none' });
  if (b.ground) {
    // Ground is clipped to the page's rounded corners by drawing it as its own
    // rounded rect that overhangs the bottom — no clipPath, no id collisions.
    m += pathEl(`M0 ${n(y)}h${n(W)}v${n(H - y - R.lg)}a${R.lg} ${R.lg} 0 0 1 ${-R.lg} ${R.lg}H${R.lg}a${R.lg} ${R.lg} 0 0 1 ${-R.lg} ${-R.lg}z`,
      { fill: c(b.ground), stroke: 'none' });
    m += pathEl(`M0 ${n(y)}h${n(W)}`, { fill: 'none', stroke: c(b.groundDeep), 'stroke-width': SW_D });
  }
  if (b.pond) {
    m += ellipse(W * 0.62, y + 58, 210, 52, solid('water', 'water_deep', SW_D));
    m += ellipse(W * 0.52, y + 44, 54, 12, { fill: c('white'), opacity: 0.4, stroke: 'none' });
  }
  if (b.sea) {
    // The sea fills the whole ground band (drawn over the base earth/sand
    // fill above it), with a few pale foam lines for texture.
    m += rrect(0, n(y), W, n(H - y), 0, { fill: c('water'), stroke: 'none' });
    m += pathEl(`M0 ${n(y)}h${n(W)}`, { fill: 'none', stroke: c('water_deep'), 'stroke-width': SW_D });
    m += ellipse(W * 0.28, n(y + 26), 70, 9, { fill: c('white'), opacity: 0.35, stroke: 'none' });
    m += ellipse(W * 0.66, n(y + 54), 95, 11, { fill: c('white'), opacity: 0.28, stroke: 'none' });
    m += ellipse(W * 0.46, n(y + 90), 110, 13, { fill: c('white'), opacity: 0.22, stroke: 'none' });
  }
  return group(m, { class: 'wi-backdrop', 'data-backdrop': name });
}

/* ---------------------------------------------------------------------------
 * renderScene(spec) -> standalone <svg> string.
 *
 * spec = {
 *   backdrop: 'garden_day', horizon: 300,
 *   props:      [ { type, x, y, scale, flip, layer, w, h, rings } ],
 *   characters: [ { id, pose, x, y, scale, flip, eye } ],
 *   alt: 'required — every image gets alt text'
 * }
 *
 * Character y is the GROUND LINE the character stands on, not its centre, so a
 * scene author positions feet and never has to reason about the 200-box.
 */
function renderScene(spec, opts = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('renderScene: no spec');
  if (!spec.alt || !String(spec.alt).trim()) throw new Error('renderScene: every scene needs alt text');

  const place = (inner, x, y, scale, flip, extra) => {
    const t = [`translate(${n(x)} ${n(y)})`];
    if (scale && scale !== 1) t.push(`scale(${n(scale)})`);
    if (flip) t.push('scale(-1 1)');
    return group(inner, Object.assign({ transform: t.join(' ') }, extra || {}));
  };

  const props = (spec.props || []);
  const backProps = props.filter((p) => p.layer !== 'front');
  const frontProps = props.filter((p) => p.layer === 'front');

  const drawProp = (p) => {
    const fn = PROPS[p.type];
    if (!fn) throw new Error(`renderScene: unknown prop "${p.type}"`);
    // o.opacity (added b384) — for an imagined/shadow/distant version of a
    // prop (29-paws-by-the-pond: "a faint fox shape suggested in the
    // shadows"), never for recolouring a cast member (see heat_tint/
    // DEPARTURES.md for that case).
    const extra = { class: `wi-prop wi-prop-${p.type}` };
    if (p.opacity != null) extra.opacity = p.opacity;
    return place(fn(p), p.x || 0, p.y || 0, p.scale || 1, !!p.flip, extra);
  };

  const drawChar = (ch) => {
    const scale = (ch.scale || 1) * ((ch.height || TOKENS.composition.character_height_default) / 150);
    const flip = !!ch.flip;
    // Local box is 200 wide with feet at y=190. ch.x is the character's CENTRE
    // and ch.y is the ground line it stands on, so a scene author places feet
    // and never reasons about the box. Flipping mirrors about that centre.
    const tx = (ch.x || 0) + (flip ? 100 : -100) * scale;
    const ty = (ch.y || TOKENS.composition.horizon_default) - 190 * scale;
    const t = [`translate(${n(tx)} ${n(ty)})`, `scale(${n(flip ? -scale : scale)} ${n(scale)})`];
    return group(renderCharacter(ch.id, ch.pose, ch.eye), { transform: t.join(' ') });
  };

  const inner =
    renderBackdrop(spec.backdrop, spec.horizon) +
    backProps.map(drawProp).join('') +
    (spec.characters || []).map(drawChar).join('') +
    frontProps.map(drawProp).join('');

  const titleId = opts.idPrefix ? `${opts.idPrefix}-t` : 'wi-t';
  return '<svg xmlns="http://www.w3.org/2000/svg" ' +
    `viewBox="0 0 ${CANVAS.width} ${CANVAS.height}" ` +
    `role="img" aria-labelledby="${titleId}" ` +
    `stroke-linecap="${TOKENS.line.linecap}" stroke-linejoin="${TOKENS.line.linejoin}" ` +
    `class="wi-scene"><title id="${titleId}">${escXml(spec.alt)}</title>` +
    inner + '</svg>';
}

function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The complete set of faces a character is allowed to wear — used by
// check-illustrations.js to prove no book ever hand-rolls an expression.
const EYE_MODES = ['open', 'happy', 'wide', 'sleepy'];
function characterFaces(id) {
  const ch = CAST[id];
  const out = {};
  EYE_MODES.forEach((m) => {
    out[m] = ch.eyes ? ch.eyes(m)
      : (ch.eyeAt ? eye(ch.eyeAt[0], ch.eyeAt[1], m, ch.eyeScale || 1, ch.fill) : '');
  });
  return out;
}

module.exports = {
  TOKENS, CAST, CAST_IDS, PROPS, PROP_NAMES, BACKDROPS, BACKDROP_NAMES,
  POSE_LIBRARY, POSE_NAMES, EYE_MODES,
  renderScene, renderCharacter, characterCore, characterFaces, renderBackdrop,
  c, escXml,
};
