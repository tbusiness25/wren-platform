'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b325 — payment references: the family's, and the child's Tax-Free Childcare one.
//
// Two kinds of reference arrive on a bank line, and this module is the one place
// that knows how to make, print and read either of them.
//
//   1. The CHILD'S TFC childcare reference — four letters, five digits (AJON12345).
//      HMRC makes it, we never do: first initial + first three letters of the
//      surname + a five-digit number. It identifies a CHILD.
//   2. The FAMILY payment reference — LA-7K2P. We make it, one per billing family,
//      siblings share it. It identifies a FAMILY.
//
// WHY A CHECK CHARACTER
//   A reference typed into a banking app by a tired parent at 11pm is the only
//   thing standing between their money and somebody else's account. The last
//   character is computed from the other three, so a single mistyped character —
//   or two characters swapped — fails to parse instead of landing on a different,
//   equally valid-looking family. That is the whole reason matching by this
//   reference is allowed to be called CERTAIN.
//
// THE ALPHABET
//   31 characters: the digits and letters that survive being read off a phone
//   screen and typed into a different one. 0 O 1 I L are gone, as Toby asked.
//   31 is PRIME, and that is not decoration: with distinct weights modulo a prime,
//   every single-character error and every adjacent transposition changes the
//   check character. Round the alphabet down to 30 and the pair (weight 2,
//   delta 15) multiplies to 30 ≡ 0, and a family paying LA-7K2P silently credits
//   whoever holds the reference 15 characters along.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

/** 31 characters. No 0, O, 1, I or L. Prime length — see the header. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const BASE = ALPHABET.length;                       // 31
const PAYLOAD_LEN = 3;                              // + 1 check character = LA-XXXC
const PREFIX = 'LA';

/** Weights for the check character. Distinct, non-zero, and all coprime to 31. */
const WEIGHTS = [2, 3, 4];

// A three-character payload can spell things nobody wants printed on a bill.
// The list is short on purpose: it is a filter on generation, never on parsing —
// a reference already issued keeps working whatever it happens to spell.
const AVOID = new Set(['ARS', 'ASS', 'BUM', 'CUM', 'FUK', 'FUX', 'GAY', 'JEW',
                       'KKK', 'NAZ', 'PEE', 'PIS', 'POO', 'SEX', 'TIT', 'WAN']);

const idxOf = (ch) => ALPHABET.indexOf(ch);

/** The check character for a payload. Throws on anything not in the alphabet. */
function checkChar(payload) {
  const p = String(payload || '').toUpperCase();
  if (p.length !== PAYLOAD_LEN) throw new Error(`payload must be ${PAYLOAD_LEN} characters`);
  let sum = 0;
  for (let i = 0; i < PAYLOAD_LEN; i++) {
    const v = idxOf(p[i]);
    if (v < 0) throw new Error(`'${p[i]}' is not in the reference alphabet`);
    sum += WEIGHTS[i] * v;
  }
  return ALPHABET[sum % BASE];
}

/** Format a payload as the reference a parent sees: LA-7K2P. */
function formatRef(payload) {
  const p = String(payload || '').toUpperCase();
  return `${PREFIX}-${p}${checkChar(p)}`;
}

/**
 * Mint a candidate reference. Randomness is crypto-grade and rejection-sampled so
 * every payload is equally likely — `% BASE` over a byte would make the first
 * eight characters of the alphabet 1.4x more common than the rest, which is a
 * small thing until two families in the same intake get adjacent references.
 *
 * Uniqueness is the DATABASE's job (family_payment_refs_ref_uq); the caller
 * retries on a conflict. Never trust a generator to be unique on its own.
 */
function mintRef() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let payload = '';
    while (payload.length < PAYLOAD_LEN) {
      const b = crypto.randomBytes(1)[0];
      if (b >= 248) continue;                       // 248 = 8 * 31: reject the tail
      payload += ALPHABET[b % BASE];
    }
    if (AVOID.has(payload)) continue;
    return formatRef(payload);
  }
  // 50 rejections in a row is not bad luck, it is a broken RNG.
  throw new Error('could not mint a payment reference');
}

/**
 * Is this a reference WE issued? Parsing only — it says the string is well formed
 * and self-consistent, never that any family holds it.
 * Accepts 'LA-7K2P', 'la7k2p', ' LA 7K2P '.
 * Returns the canonical 'LA-7K2P', or null.
 */
function parseRef(raw) {
  const squashed = String(raw || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const m = squashed.match(new RegExp(`^${PREFIX}([${ALPHABET}]{${PAYLOAD_LEN + 1}})$`));
  if (!m) return null;
  const body = m[1];
  const payload = body.slice(0, PAYLOAD_LEN);
  let expect;
  try { expect = checkChar(payload); } catch (_) { return null; }
  return body[PAYLOAD_LEN] === expect ? formatRef(payload) : null;
}

/**
 * The maximal alphanumeric runs in a bank narrative, in order.
 *
 * THE RULE THIS EXISTS TO ENFORCE: a reference must occupy WHOLE runs.
 *
 * The obvious implementation — strip the punctuation and scan the resulting one
 * long word — finds LA-7K2Z inside "VILLA7K2ZXX", and calls it certain. The check
 * character does not save you here: it only has to agree with the three
 * characters the slice happened to land on. Requiring the reference to be one run
 * ("LA7K2Z"), or a sequence of consecutive whole runs ("LA" "7K2Z", however the
 * bank punctuated the gap), uses the separators the bank kept instead of throwing
 * them away, and "VILLA7K2ZXX" is a single eleven-character run that no
 * six-character reference can be made of.
 */
function alnumRuns(text) {
  return String(text || '').toUpperCase().match(/[A-Z0-9]+/g) || [];
}

/**
 * Scan the runs for strings of exactly `len` characters built from consecutive
 * whole runs, and hand each to `accept`. Non-null returns are collected, deduped
 * on their `key`.
 */
function scanRuns(text, len, accept) {
  const runs = alnumRuns(text);
  const out = [], seen = new Set();
  for (let i = 0; i < runs.length; i++) {
    let joined = '';
    for (let j = i; j < runs.length && joined.length < len; j++) {
      joined += runs[j];
      if (joined.length !== len) continue;
      const hit = accept(joined, runs.slice(i, j + 1).join(' '));
      if (hit && !seen.has(hit.key)) { seen.add(hit.key); out.push(hit.value); }
    }
  }
  return out;
}

/**
 * Every family reference a bank narrative contains.
 * Returns [{ ref, token }], deduped, in the order found.
 */
function findRefsInText(text) {
  return scanRuns(text, PREFIX.length + PAYLOAD_LEN + 1, (joined, token) => {
    const ref = parseRef(joined);
    return ref ? { key: ref, value: { ref, token } } : null;
  });
}

// ── Tax-Free Childcare ───────────────────────────────────────────────────────

/** HMRC's shape: four letters then five digits. */
const TFC_RE = /^[A-Z]{4}[0-9]{5}$/;

/** Normalise a TFC reference a parent typed. Returns the canonical form, or null. */
function parseTfcRef(raw) {
  let v = String(raw || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  // 2026-10-05: HMRC prints the reference as AJON12345TFC. Parents copy it exactly,
  // and that was refused as "not four letters then five digits". The TFC tail
  // carries nothing, so it is dropped and the nine characters kept.
  if (/^[A-Z]{4}[0-9]{5}TFC$/.test(v)) v = v.slice(0, 9);
  return TFC_RE.test(v) ? v : null;
}

/**
 * Every TFC childcare reference in a bank narrative.
 *
 * Whole runs, the same rule as findRefsInText and for the same reason: HMRC also
 * quotes the 13-digit account number, and a nine-character slice out of the
 * middle of "TFC1100012345678" must not read as a childcare reference. Accepting
 * consecutive runs means "AJON 12345" is read too — parents do type it that way.
 */
function findTfcRefsInText(text) {
  // AJON12345TFC arrives as one 12-character run; split the TFC tail off so the
  // nine-character reference stands as its own run (2026-10-05).
  text = String(text || '').replace(/([A-Za-z]{4}\s?[0-9]{5})\s?TFC(?![A-Za-z0-9])/gi, '$1 TFC');
  return scanRuns(text, 9, (joined) =>
    TFC_RE.test(joined) ? { key: joined, value: joined } : null);
}

/** The 13-digit HMRC TFC account number (starts 1100). Corroboration, not identity. */
function findTfcAccountNumbers(text) {
  const up = String(text || '').toUpperCase();
  const out = new Set();
  for (const m of up.matchAll(/(?<![0-9])(1100[0-9]{9})(?![0-9])/g)) out.add(m[1]);
  return [...out];
}

/** Does the narrative look like it came from HMRC's TFC scheme at all? */
function looksLikeTfcPayer(text) {
  const up = String(text || '').toUpperCase();
  return /NATIONAL\s*SAVINGS|\bNS&?I\b|TAX[\s-]?FREE|\bTFC\b/.test(up);
}

/**
 * The letters HMRC would have used for this child: first initial + the first three
 * letters of the surname.
 *
 * Returns EVERY plausible answer, not one. A double-barrelled surname gives three
 * (each part, and the parts run together), because HMRC's four letters were
 * decided by whatever the parent wrote on the application — which is not
 * necessarily what we hold. This list exists to decide whether to WARN, and a
 * warning that fires on every hyphenated surname is a warning people learn to
 * ignore.
 */
function expectedTfcLetters(firstName, lastName) {
  const letters = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  const initial = letters(firstName).slice(0, 1);
  if (!initial) return [];
  const surname = String(lastName || '');
  const parts = surname.split(/[^A-Za-z]+/).map(letters).filter(Boolean);
  const stems = new Set();
  for (const p of parts) if (p.length >= 1) stems.add(p.slice(0, 3));
  if (parts.length > 1) stems.add(parts.join('').slice(0, 3));
  const out = [];
  for (const stem of stems) if (stem.length === 3) out.push(initial + stem);
  return out;
}

/**
 * Check a TFC reference against the child's name.
 *
 * WARN, NEVER BLOCK. Toby was explicit: double-barrelled and changed surnames are
 * real, and a family whose reference is correct must not be stopped by our guess
 * at their name. `ok:false` means "show the manager a note", not "refuse".
 *
 * Returns { ok, ref, expected, warning }. `ref` is null when the SHAPE is wrong —
 * that one the caller may reject, because a string that is not four letters and
 * five digits is not a TFC reference at all.
 */
function checkTfcRef(raw, firstName, lastName) {
  const ref = parseTfcRef(raw);
  if (!ref) {
    return { ok: false, ref: null, expected: [],
      warning: 'A Tax-Free Childcare reference is four letters then five digits, like AJON12345.' };
  }
  const expected = expectedTfcLetters(firstName, lastName);
  const given = ref.slice(0, 4);
  if (!expected.length || expected.includes(given)) return { ok: true, ref, expected, warning: null };
  return {
    ok: false, ref, expected,
    warning: `This reference starts ${given}; for ${String(firstName || '').trim()} `
           + `${String(lastName || '').trim()} we would have expected ${expected.join(' or ')}. `
           + `That is fine if the surname on your HMRC account is different — we have saved it either way.`,
  };
}

// ── Payer memory (match kind 3) ──────────────────────────────────────────────

/**
 * The key a confirmed payer is remembered under.
 *
 * Built from the payer NAME the feed gives (Xero's contact name, or the narrative
 * when there is none), squashed to letters and digits so casing, punctuation and
 * the bank's own spacing cannot make the same payer look like a new one each
 * month. Trailing digits are kept: "J SMITH 12345678" and "J SMITH 87654321" are
 * two different accounts and must not collapse into one memory.
 *
 * Returns null for anything too short to identify a person — an empty memory is
 * better than one keyed on "BACS".
 */
function payerKey(payerName, fallbackText) {
  const src = String(payerName || '').trim() || String(fallbackText || '').trim();
  const key = src.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (key.length < 4) return null;
  return key.slice(0, 200);
}

module.exports = {
  ALPHABET, BASE, PREFIX, PAYLOAD_LEN, WEIGHTS,
  checkChar, formatRef, mintRef, parseRef, findRefsInText,
  TFC_RE, parseTfcRef, findTfcRefsInText, findTfcAccountNumbers, looksLikeTfcPayer,
  expectedTfcLetters, checkTfcRef,
  payerKey,
};
