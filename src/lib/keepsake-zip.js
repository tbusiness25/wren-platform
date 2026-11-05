'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// The memory book as a folder in a zip — Toby, 2026-09-23:
//   "Is there not a way we can format it and give it to them as a download that's not a PDF,
//    not an app, but it's easy for them to read and view and see the videos as well?"
//    …and "if it has links does that mean we'll have to host the media? I don't want to waste space."
//
// Nothing is hosted. The family gets ONE file. They unzip it, double-click index.html, and it
// opens in whatever browser they already have, with the photographs and the VIDEOS playing from
// the folder beside it. It works with no internet, forever, on a phone, a laptop or a school PC.
//
// Why not the other three:
//   • PDF   — cannot hold video at all. That is why they saw black squares.
//   • One self-contained HTML with everything base64'd — the existing /download. Fine for a small
//     book, but base64 inflates by ~37%, and one leaver here has 368 MB of media, which becomes
//     a 505 MB single file. No phone opens that.
//   • An app — Toby ruled it out, rightly. This needs to outlive us.
//
// Written by hand because the host has no `zip` binary and no archiver module, and a keepsake
// should not gain an npm dependency. Media is already compressed (JPEG/MP4), so everything is
// STORED rather than deflated: no CPU, no gain lost, and the format stays simple enough to read.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// CRC32, table built once.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
// DOS date/time, which is what a zip entry carries.
function dosTime(d) {
  const t = ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xFFFF;
  const dt = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  return { t, dt };
}

/**
 * Build a zip from entries [{ name, data }] or [{ name, file }].
 * Returns a Buffer. Stored (method 0) throughout.
 */
function buildZip(entries, when) {
  const now = when || new Date();
  const { t, dt } = dosTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8');
    const data = e.data !== undefined ? (Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8'))
                                      : fs.readFileSync(e.file);
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);            // version needed
    lfh.writeUInt16LE(0x0800, 6);        // UTF-8 names
    lfh.writeUInt16LE(0, 8);             // method 0 = stored
    lfh.writeUInt16LE(t, 10); lfh.writeUInt16LE(dt, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);  // compressed
    lfh.writeUInt32LE(data.length, 22);  // uncompressed
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, name, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(t, 12); cdh.writeUInt16LE(dt, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(0, 38);            // external attrs
    cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, name]));

    offset += lfh.length + name.length + data.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

module.exports = { buildZip, crc32 };
