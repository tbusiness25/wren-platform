'use strict';
/**
 * media-watermark.js — b265 (2026-09-01)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bakes the viewing family's identity into parent-facing photographs, at
 * request time, server-side.
 *
 * WHAT THIS IS FOR — and what it is not
 * ------------------------------------
 * It does not stop a screenshot. Nothing does, on any platform; Famly says so
 * in their own documentation and we say it to parents too (see
 * child-permissions.MEDIA_REALITY_NOTICE). What it does is make a leaked image
 * traceable to the account that was shown it — which is the only deterrent that
 * survives a screenshot, because the watermark is in the pixels the screenshot
 * copies.
 *
 * Two marks are applied:
 *   1. a faint diagonal tile of the identity across the whole frame — survives
 *      cropping, and is the one that matters;
 *   2. a readable caption strip along the bottom — the visible, honest "this
 *      copy was issued to you" line.
 * Both are deliberately restrained. A photograph a parent does not want to look
 * at is a worse outcome than an unmarked one.
 *
 * JPEG files additionally get a COM (comment) segment carrying the same
 * identity, so a downloaded file is traceable from its metadata even if the
 * picture is later cropped below the caption.
 *
 * DEPENDENCIES
 * ------------
 * jpeg-js (pure JS, no native build) and pngjs (already present). There is no
 * ImageMagick, no sharp and no Pillow in the app image — checked. If either
 * module is missing the caller still gets the original bytes back with
 * applied:false; a parent seeing an unmarked photo is far better than a parent
 * seeing a broken one.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');

// ── 5×7 bitmap font ──────────────────────────────────────────────────────────
// Hand-drawn rather than pulled in as a dependency: five columns is all a
// watermark needs, and a font package would be a native/So-large-it-hurts dep
// for eight hundred bytes of pixels.
const GLYPHS = {
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  'J': ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '.#...'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '@': ['.###.', '#...#', '#.###', '#.#.#', '#.###', '#....', '.###.'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
};
const GLYPH_W = 5, GLYPH_H = 7, GLYPH_GAP = 1;

// Fold anything we have no glyph for onto something we do, rather than dropping
// it — a name rendered with a gap in it is still traceable, a name silently
// shortened is not.
function normaliseChar(ch) {
  const up = ch.toUpperCase();
  if (GLYPHS[up]) return up;
  if (/[·•]/.test(ch)) return '.';
  if (/[–—]/.test(ch)) return '-';
  if (/[‘’]/.test(ch)) return "'";
  // strip accents (José → JOSE) before giving up
  const de = up.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (GLYPHS[de]) return de;
  return GLYPHS[up] ? up : '.';
}

function textWidth(text, scale) {
  return text.length ? (text.length * (GLYPH_W + GLYPH_GAP) - GLYPH_GAP) * scale : 0;
}

/**
 * Every lit pixel of `text`, as [x, y] offsets from the string's top-left, at
 * the given integer scale. Produced once and reused for each tile.
 */
function textPixels(text, scale) {
  const pts = [];
  for (let i = 0; i < text.length; i++) {
    const g = GLYPHS[normaliseChar(text[i])];
    if (!g) continue;
    const ox = i * (GLYPH_W + GLYPH_GAP) * scale;
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (g[row][col] !== '#') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) pts.push([ox + col * scale + sx, row * scale + sy]);
        }
      }
    }
  }
  return pts;
}

// ── Raster helpers (RGBA, 4 bytes/px) ────────────────────────────────────────
function blend(ras, x, y, r, g, b, a) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= ras.width || y >= ras.height) return;
  const i = (y * ras.width + x) * 4;
  const d = ras.data;
  d[i]     = d[i]     + (r - d[i])     * a;
  d[i + 1] = d[i + 1] + (g - d[i + 1]) * a;
  d[i + 2] = d[i + 2] + (b - d[i + 2]) * a;
}

function fillRect(ras, x0, y0, w, h, r, g, b, a) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) blend(ras, x, y, r, g, b, a);
  }
}

/** Draw text upright, with a one-pixel dark halo so it reads on any background. */
function drawText(ras, text, x0, y0, scale, alpha) {
  const pts = textPixels(text, scale);
  for (const [dx, dy] of pts) {
    blend(ras, x0 + dx + scale, y0 + dy + scale, 0, 0, 0, alpha * 0.55);
  }
  for (const [dx, dy] of pts) {
    blend(ras, x0 + dx, y0 + dy, 255, 255, 255, alpha);
  }
}

/**
 * Tile `text` diagonally across the whole raster. This is the mark that
 * survives a crop — the caption strip does not.
 */
function drawDiagonalTile(ras, text, scale, alpha) {
  const pts = textPixels(text, scale);
  if (!pts.length) return;
  const w = textWidth(text, scale);
  const h = GLYPH_H * scale;
  const ang = -Math.PI / 6;                 // 30° up to the right
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const stepX = Math.max(80, Math.round(w * 2.2));
  const stepY = Math.max(70, Math.round(h * 7));
  // Start off-canvas on both axes so rotated tiles still cover the corners.
  for (let ty = -stepY; ty < ras.height + stepY; ty += stepY) {
    // stagger alternate rows so the tiling does not read as a grid
    const odd = Math.round(ty / stepY) % 2 ? Math.round(stepX / 2) : 0;
    for (let tx = -stepX + odd; tx < ras.width + stepX; tx += stepX) {
      for (const [dx, dy] of pts) {
        const px = tx + (dx * cos - dy * sin);
        const py = ty + (dx * sin + dy * cos);
        // 2×2 splat: rotation leaves gaps in a 1px stroke and the text
        // becomes unreadable, which defeats the point of a traceable mark.
        blend(ras, px,     py,     255, 255, 255, alpha);
        blend(ras, px + 1, py,     255, 255, 255, alpha);
        blend(ras, px,     py + 1, 255, 255, 255, alpha);
        blend(ras, px + 1, py + 1, 255, 255, 255, alpha);
      }
    }
  }
}

/** Caption strip along the bottom: a dark band with the identity line on it. */
function drawCaption(ras, text, scale, bandAlpha, textAlpha) {
  const pad = Math.max(4, Math.round(4 * scale));
  const bandH = GLYPH_H * scale + pad * 2;
  const y0 = ras.height - bandH;
  if (y0 < 0) return;
  fillRect(ras, 0, y0, ras.width, bandH, 0, 0, 0, bandAlpha);
  // Trim rather than overflow if the identity is longer than the frame.
  let line = text;
  while (textWidth(line, scale) > ras.width - pad * 2 && line.length > 4) {
    line = line.slice(0, -2);
  }
  if (line !== text) line = line.slice(0, -1) + '.';
  drawText(ras, line, pad, y0 + pad, scale, textAlpha);
}

// ── JPEG COM segment ─────────────────────────────────────────────────────────
/**
 * Insert a JPEG comment carrying the identity, straight after SOI. Pure byte
 * work — no decode — so it is always available even if jpeg-js is not.
 */
function stampJpegComment(buf, comment) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return buf;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;   // not a JPEG
  const body = Buffer.from(String(comment).slice(0, 2000), 'utf8');
  const seg = Buffer.alloc(4 + body.length);
  seg[0] = 0xFF; seg[1] = 0xFE;                          // COM marker
  seg.writeUInt16BE(body.length + 2, 2);
  body.copy(seg, 4);
  return Buffer.concat([buf.subarray(0, 2), seg, buf.subarray(2)]);
}

// ── Small result cache ───────────────────────────────────────────────────────
// Same photo + same family = same bytes, and a journey page pulls a dozen at
// once. Bounded hard on both count and total bytes so a busy morning cannot
// walk the container into an OOM.
const CACHE = new Map();
const CACHE_MAX_ENTRIES = 80;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
let cacheBytes = 0;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  CACHE.delete(key); CACHE.set(key, hit);   // LRU touch
  return hit;
}

function cachePut(key, buf) {
  if (buf.length > CACHE_MAX_BYTES / 4) return;   // never let one file dominate
  CACHE.set(key, buf);
  cacheBytes += buf.length;
  while (CACHE.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = CACHE.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= CACHE.get(oldest).length;
    CACHE.delete(oldest);
  }
}

function clearCache() { CACHE.clear(); cacheBytes = 0; }

// ── Public API ───────────────────────────────────────────────────────────────
const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.3gp': 'video/3gpp', '.mkv': 'video/x-matroska',
};

function mimeForExt(ext) { return EXT_MIME[String(ext).toLowerCase()] || 'application/octet-stream'; }

/** True when we can actually mark this type. webp/gif/video: no decoder here. */
function canWatermark(mime) { return mime === 'image/jpeg' || mime === 'image/png'; }

/**
 * Watermark an image with the viewing family's identity.
 *
 * @param {Buffer} buf      original file bytes
 * @param {string} mime     'image/jpeg' | 'image/png' | anything else (passthrough)
 * @param {string} identity the line to burn in, e.g. "Sam Okafor · 1 Sep 2026"
 * @param {object} [opts]   {quality, cacheKey}
 * @returns {{buffer:Buffer, mime:string, applied:boolean, reason?:string}}
 */
function watermarkImage(buf, mime, identity, opts) {
  const o = opts || {};
  const text = String(identity || '').trim();
  if (!text) return { buffer: buf, mime, applied: false, reason: 'no_identity' };
  if (!canWatermark(mime)) return { buffer: buf, mime, applied: false, reason: 'unsupported_type' };

  const key = o.cacheKey
    ? crypto.createHash('sha1').update(o.cacheKey + ' ' + text).digest('hex')
    : null;
  if (key) {
    const hit = cacheGet(key);
    if (hit) return { buffer: hit, mime, applied: true, cached: true };
  }

  let ras;
  try {
    if (mime === 'image/jpeg') {
      const jpeg = require('jpeg-js');
      const d = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
      ras = { width: d.width, height: d.height, data: d.data };
    } else {
      const { PNG } = require('pngjs');
      const p = PNG.sync.read(buf);
      ras = { width: p.width, height: p.height, data: p.data };
    }
  } catch (e) {
    return { buffer: buf, mime, applied: false, reason: 'decode_failed:' + e.message };
  }

  if (!ras.width || !ras.height) return { buffer: buf, mime, applied: false, reason: 'empty_image' };

  // Scale with the picture so a thumbnail is not swamped and a big photo is not
  // marked with something you need to squint at.
  const tileScale = Math.max(1, Math.round(ras.width / 520));
  const capScale  = Math.max(1, Math.round(ras.width / 430));

  try {
    drawDiagonalTile(ras, text, tileScale, 0.10);
    drawCaption(ras, text, capScale, 0.34, 0.80);
  } catch (e) {
    return { buffer: buf, mime, applied: false, reason: 'draw_failed:' + e.message };
  }

  let out;
  try {
    if (mime === 'image/jpeg') {
      const jpeg = require('jpeg-js');
      out = jpeg.encode({ data: Buffer.from(ras.data), width: ras.width, height: ras.height },
                        o.quality || 86).data;
      out = stampJpegComment(out, 'Wren: issued to ' + text);
    } else {
      const { PNG } = require('pngjs');
      const png = new PNG({ width: ras.width, height: ras.height });
      Buffer.from(ras.data).copy(png.data);
      out = PNG.sync.write(png);
    }
  } catch (e) {
    return { buffer: buf, mime, applied: false, reason: 'encode_failed:' + e.message };
  }

  if (key) cachePut(key, out);
  return { buffer: out, mime, applied: true };
}

/**
 * The identity line shown on a parent's copy. Kept here so every surface that
 * marks a file words it the same way.
 */
function identityLine(name, email, date) {
  const who = String(name || '').trim() || String(email || '').trim().split('@')[0] || 'Parent copy';
  const d = date instanceof Date ? date : new Date();
  const stamp = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${who} - ${stamp} - Your Nursery`;
}

module.exports = {
  watermarkImage,
  stampJpegComment,
  identityLine,
  canWatermark,
  mimeForExt,
  clearCache,
  // exported for the b265 test harness
  _internals: { textPixels, textWidth, GLYPHS },
};
