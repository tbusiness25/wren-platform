'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b321 — what has to happen to a file between "a parent pressed Upload" and
// "it is on our disk".
//
// THREE SEPARATE JOBS, and they are separate on purpose:
//
//   sniff()    What IS this file? Read the MAGIC BYTES. An extension is a claim
//              made by whoever named the file; it is not evidence. `.jpg` on a
//              zip is the oldest trick there is, and person_documents streams
//              its files back with the stored mime in the Content-Type header,
//              so believing the extension means letting an uploader choose what
//              the browser does with the bytes.
//
//   strip()    Remove the metadata. A photo taken on a phone in the nursery
//              carries the GPS coordinates of the nursery, the phone's serial,
//              and a thumbnail that survives cropping. We are asking families
//              for a picture of their child — we are not asking for their home
//              address, and if we take it anyway we are holding it.
//
//   dimensions() How big is it? Needed to lay the picture out on A4 and on the
//              peg sheet without distorting it, and it doubles as a structural
//              check: a file whose header does not yield a width is not the
//              image it claims to be, whatever its magic bytes said.
//
// WHY NO IMAGE LIBRARY
//
// There is no sharp, no jimp and no ImageMagick in the Wren image (Alpine/musl —
// see the note about puppeteer). Adding a native dependency to strip a handful
// of bytes would be a large amount of new attack surface for a small job.
//
// So the stripping is done by walking the CONTAINER FORMAT and dropping the
// metadata segments, which is both lossless and exact:
//   JPEG  — a chain of markers. EXIF is APP1, XMP is APP1, ICC is APP2,
//           Photoshop/IPTC is APP13. Drop APP1..APP15 and COM, keep APP0 (JFIF)
//           and every compressed-data marker. The pixels are never touched.
//   PNG   — a chain of chunks. eXIf/tEXt/iTXt/zTXt/tIME/dSIG carry metadata.
//           Drop those, keep everything else (including the colour chunks —
//           dropping gAMA/cHRM/iCCP would visibly change the colours).
//   WebP  — a RIFF container. Drop the EXIF and XMP chunks and fix the RIFF
//           length, and clear the flags in VP8X that advertise them.
//
// Re-encoding with jpeg-js WOULD also remove metadata, but it would decode and
// re-compress an 8MP photo in the request path — slow, lossy, and it would turn
// a 4MB upload into a much larger one. Dropping segments is better on every
// axis.
//
// HEIC IS REFUSED, DELIBERATELY
//
// An iPhone photo is HEIC, and its EXIF lives in a separate item inside an
// ISO-BMFF meta box that has to be re-indexed to remove — not a segment you can
// drop. A stripper that quietly did nothing to HEIC would be worse than no
// stripper, because the row would say exif_stripped=true. So HEIC is rejected
// with a message that tells the parent how to fix it. iOS converts to JPEG on
// upload from Safari's file picker in most configurations, so this is a rare
// path, not the normal one.
// ─────────────────────────────────────────────────────────────────────────────

/** Magic-byte signatures, longest first so the specific ones win. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg', kind: 'image' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: '.png', kind: 'image' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp', kind: 'image' };
  }
  // PDF: %PDF-
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') {
    return { mime: 'application/pdf', ext: '.pdf', kind: 'document' };
  }
  // HEIC/HEIF: ....ftyp<brand>, brand in heic/heix/hevc/heim/heis/mif1/msf1
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) {
      return { mime: 'image/heic', ext: '.heic', kind: 'image', strippable: false };
    }
    if (/^(isom|mp41|mp42|avc1|M4V |qt  )$/.test(brand)) {
      return { mime: 'video/mp4', ext: '.mp4', kind: 'video', strippable: false };
    }
  }
  // GIF — accepted by the sniffer so the error message can name it, not silently
  // fall through to "unrecognised".
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a') {
    return { mime: 'image/gif', ext: '.gif', kind: 'image', strippable: false };
  }
  return null;
}

// ── JPEG ────────────────────────────────────────────────────────────────────
// Markers we drop. APP1 is EXIF *and* XMP; APP2 is ICC/FlashPix; APP13 is
// Photoshop IRB, which is where IPTC captions and (historically) GPS live.
// APP0 (0xE0) is JFIF density — keeping it means the image still reports its
// DPI, which matters for the A4 print.
const JPEG_DROP = new Set([
  0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
  0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef,        // APP1..APP15
  0xfe,                                            // COM
]);

function stripJpeg(buf) {
  const out = [Buffer.from([0xff, 0xd8])];
  const removed = [];
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }         // resync on a stray byte
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }         // fill byte
    // Standalone markers (no length): RSTn and SOI/EOI/TEM.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      out.push(buf.slice(i, i + 2)); i += 2; continue;
    }
    // Start of Scan: everything from here to the end is entropy-coded data
    // plus trailing markers. Copy it wholesale — there is no metadata after
    // SOS that a phone writes, and parsing entropy data to find EOI is a
    // needless risk.
    if (marker === 0xda) { out.push(buf.slice(i)); i = buf.length; break; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) break;  // truncated — stop cleanly
    if (JPEG_DROP.has(marker)) {
      removed.push(marker === 0xfe ? 'COM' : 'APP' + (marker - 0xe0));
    } else {
      out.push(buf.slice(i, i + 2 + len));
    }
    i += 2 + len;
  }
  return { buffer: Buffer.concat(out), removed };
}

// ── PNG ─────────────────────────────────────────────────────────────────────
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME', 'dSIG']);

function stripPng(buf) {
  const out = [buf.slice(0, 8)];
  const removed = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;                        // len + type + data + crc
    if (end > buf.length) break;                     // truncated
    if (PNG_DROP.has(type)) removed.push(type);
    else out.push(buf.slice(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return { buffer: Buffer.concat(out), removed };
}

// ── WebP ────────────────────────────────────────────────────────────────────
function stripWebp(buf) {
  const removed = [];
  const chunks = [];
  let i = 12;                                        // past RIFF####WEBP
  while (i + 8 <= buf.length) {
    const type = buf.slice(i, i + 4).toString('latin1');
    const len = buf.readUInt32LE(i + 4);
    const padded = len + (len % 2);                  // RIFF chunks are even-aligned
    const end = i + 8 + padded;
    if (end > buf.length) break;
    if (type === 'EXIF' || type === 'XMP ') removed.push(type.trim());
    else chunks.push(buf.slice(i, end));
    i = end;
  }
  if (!removed.length) return { buffer: buf, removed };
  const body = Buffer.concat(chunks);
  // VP8X advertises which optional chunks are present; leaving the EXIF/XMP
  // bits set after removing them produces a file that decoders complain about.
  if (body.length >= 16 && body.slice(0, 4).toString('latin1') === 'VP8X') {
    body[8] = body[8] & ~0x0c;                       // clear the EXIF + XMP flags
  }
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return { buffer: Buffer.concat([head, body]), removed };
}

/**
 * Remove every metadata segment we can remove losslessly.
 * @returns {{buffer:Buffer, stripped:boolean, removed:string[]}}
 *          stripped=false means "this format is not one we can clean", which is
 *          a different statement from "there was nothing to clean" (removed:[]).
 */
function strip(buf, mime) {
  try {
    if (mime === 'image/jpeg') { const r = stripJpeg(buf); return { ...r, stripped: true }; }
    if (mime === 'image/png')  { const r = stripPng(buf);  return { ...r, stripped: true }; }
    if (mime === 'image/webp') { const r = stripWebp(buf); return { ...r, stripped: true }; }
  } catch (e) {
    // A parse failure must not silently return the ORIGINAL bytes while the
    // caller records exif_stripped=true. Fail loudly enough to be refused.
    return { buffer: buf, stripped: false, removed: [], error: e.message };
  }
  return { buffer: buf, stripped: false, removed: [] };
}

/** Does this buffer still carry an EXIF/XMP marker? Used by the verifier. */
function hasMetadata(buf, mime) {
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i < buf.length - 1) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if ((m >= 0xd0 && m <= 0xd9) || m === 0x01) { i += 2; continue; }
      if (m === 0xda) return false;
      if (JPEG_DROP.has(m)) return true;
      const len = buf.readUInt16BE(i + 2);
      if (len < 2 || i + 2 + len > buf.length) return false;
      i += 2 + len;
    }
    return false;
  }
  if (mime === 'image/png') {
    let i = 8;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const type = buf.slice(i + 4, i + 8).toString('latin1');
      if (PNG_DROP.has(type)) return true;
      i += 12 + len;
      if (type === 'IEND') break;
    }
    return false;
  }
  if (mime === 'image/webp') {
    let i = 12;
    while (i + 8 <= buf.length) {
      const type = buf.slice(i, i + 4).toString('latin1');
      const len = buf.readUInt32LE(i + 4);
      if (type === 'EXIF' || type === 'XMP ') return true;
      i += 8 + len + (len % 2);
    }
    return false;
  }
  return false;
}

// ── dimensions ───────────────────────────────────────────────────────────────
function dimensions(buf, mime) {
  try {
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length - 1) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m === 0xff) { i++; continue; }
        if ((m >= 0xd0 && m <= 0xd9) || m === 0x01) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        // Every SOFn carries the frame size except SOF4/SOF8/SOF12 (DHT/JPG/DAC).
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        if (len < 2) break;
        i += 2 + len;
      }
      return null;
    }
    if (mime === 'image/png') {
      // IHDR is mandatory and always the first chunk.
      if (buf.slice(12, 16).toString('latin1') !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/webp') {
      const type = buf.slice(12, 16).toString('latin1');
      if (type === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
      if (type === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (type === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
  } catch (_) { /* a malformed header is "no dimensions", not a crash */ }
  return null;
}

module.exports = { sniff, strip, hasMetadata, dimensions };
