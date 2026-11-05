'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b321 — the four things a family sends us when their child starts, and what
// each one costs us to keep.
//
// Toby's brief: an A4 family picture, a slightly-bigger-than-passport portrait
// for the child's peg, allergy documentation, and medicine/health documents.
// Staff download and print them; they are deleted in line with the retention
// policy.
//
// TWO RULES LIVE HERE AND NOWHERE ELSE.
//
// 1. THE RETENTION CLASS OF A DOCUMENT.
//    b308 established four classes and its own file (src/lib/archive-classes.js)
//    is the authority for TABLES. A document is finer-grained than a table: an
//    allergy letter and an individual health care plan are both rows in
//    person_documents and they die 22 years apart. So the class is decided from
//    the CATEGORY, here, once, and written onto the row at upload — see the
//    migration for why it is stored rather than re-derived.
//
//      family photo, peg portrait      → handover
//         Not a record about the child. It is the family's picture, lent to us
//         to print and pin up. Offered back / deleted when they leave.
//      allergy documents, medicines    → ordinary
//         3 years after leaving, or the next Ofsted inspection if later. These
//         ARE named in the schedule ("medication records").
//      individual health care plan     → protected
//         25 years from date of birth. The schedule names health care plans
//         alongside child protection and SEND, and it is the one thing in this
//         build a parent could upload that runs for a quarter of a century.
//
//    That is deliberately the b308 vocabulary and not a fifth class. "Photos
//    are different" is true, but it is a different ANCHOR, not a different
//    clock, and handover already anchors on the leaving date.
//
// 2. AN ALLERGY DOCUMENT MUST NOT BE A DEAD END.
//    b314 found that a food allergy typed into All About Me never reached the
//    kitchen, because the chef's sheet read a different column. An allergy
//    letter uploaded as a PDF is the same failure one step earlier: the file
//    sits on the profile, the structured allergy field stays empty, and the
//    day sheet says the child has no allergies. So an allergy upload against a
//    child with nothing in EITHER allergy box raises a task. The check reads
//    both boxes, for exactly the reason b314 exists.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const IMG = require('./image-safety');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

// ── The family-facing types ──────────────────────────────────────────────────
// `accept` is what the SNIFFER must return, never what the filename says.
const DOC_TYPES = {
  family_photo: {
    label: 'Family photo',
    blurb: 'A picture of your family, which we print at A4 and put up in the room.',
    hint: 'Landscape or portrait both work. A photo straight off a phone is ideal.',
    retention: 'handover',
    // JPG/PNG only, and the reason is downstream: the A4 and peg-sheet prints
    // are built with pdfkit, which can embed JPEG and PNG and nothing else.
    // Accepting WebP here would mean accepting a photo we cannot print, which
    // is the only thing this photo is for. Refuse it at the door instead.
    accept: ['image/jpeg', 'image/png'],
    maxBytes: 15 * 1024 * 1024,
    familyFacing: true,
    icon: '🖼️',
  },
  peg_portrait: {
    label: 'Photo for their peg',
    blurb: "A head-and-shoulders photo of your child, printed about 45 × 55 mm for their coat peg.",
    hint: 'Just your child, facing the camera, with their face filling most of the frame.',
    retention: 'handover',
    accept: ['image/jpeg', 'image/png'],   // printable formats only — see above
    maxBytes: 15 * 1024 * 1024,
    familyFacing: true,
    icon: '🧥',
  },
  allergy_doc: {
    label: 'Allergy documentation',
    blurb: 'An allergy letter from your GP or consultant, or an allergy action plan.',
    hint: 'A photo of the letter is fine if you do not have a PDF.',
    retention: 'ordinary',
    accept: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 20 * 1024 * 1024,
    familyFacing: true,
    icon: '🥜',
  },
  medicine_doc: {
    label: 'Medicine or health document',
    blurb: 'A prescription, a care plan, or instructions for medicine we may need to give.',
    hint: 'Please make sure the dose and your child’s name are readable.',
    retention: 'ordinary',
    accept: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 20 * 1024 * 1024,
    familyFacing: true,
    icon: '💊',
  },
  health_care_plan: {
    label: 'Individual health care plan',
    blurb: 'A named care plan for an ongoing condition — asthma, epilepsy, diabetes.',
    hint: 'We have to keep this one for much longer than the others.',
    retention: 'protected',
    accept: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 20 * 1024 * 1024,
    familyFacing: true,
    icon: '🩺',
  },
  // b422 (2026-10-08) — registration welcome pack: the red book / immunisation
  // record a family can upload instead of (or alongside) just confirming it's up
  // to date on /welcome/redbook. Same retention as the other medical documents —
  // this is "medication records" territory, not a 25-year health care plan.
  red_book: {
    label: 'Red book / immunisation record',
    blurb: 'Your child’s red book or immunisation record, if you’d like to share a copy.',
    hint: 'A photo of the relevant pages is fine.',
    retention: 'ordinary',
    accept: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 20 * 1024 * 1024,
    familyFacing: true,
    icon: '📕',
  },
};

/** Categories that hold a printable photograph of a person. */
const PHOTO_CATEGORIES = ['family_photo', 'peg_portrait'];

/** b104's original categories keep the classes the migration backfilled. */
const LEGACY_CLASS = {
  photo_consent: 'consent',
  ehcp: 'protected',
  medical: 'protected',
  report: 'handover',
  contract: 'ordinary',
  certificate: null,       // ambiguous — leave for b308's paranoid default
  other: null,
};

/**
 * The one decision. Returns null where the category genuinely does not imply a
 * class — a null is honest, and b308 treats an unclassified thing as protected
 * and flags it for a human, which is the behaviour we want for "other".
 */
function classFor(category) {
  if (DOC_TYPES[category]) return DOC_TYPES[category].retention;
  if (category in LEGACY_CLASS) return LEGACY_CLASS[category];
  return null;
}

/** Human sentence for the UI — why this file has the lifetime it has. */
const CLASS_NOTE = {
  handover: 'Yours, not ours — offered back and deleted when your child leaves.',
  ordinary: 'Kept for 3 years after your child leaves (or until our next Ofsted inspection).',
  consent:  'Kept for 21 years and 6 months.',
  protected:'Kept until your child is 25 — the law requires it for health care plans.',
};

// ── The upload pipeline ──────────────────────────────────────────────────────

/**
 * Everything that must be true of the bytes before they touch disk, and the
 * cleaning that happens on the way. Pure — no DB, no filesystem — so the
 * registration route and the authenticated route cannot drift apart.
 *
 * @param {Buffer} buf       the raw upload
 * @param {string} category  one of DOC_TYPES (or a b104 legacy category)
 * @returns {{ok:true, buffer, mime, ext, width, height, exifStripped, removed, sha256}
 *          |{ok:false, error:string}}
 *
 * The uploader's filename is deliberately NOT a parameter. Every message this
 * produces names the type the BYTES turned out to be, because telling someone
 * "your .jpg is not a JPG" is the useful sentence and repeating the name they
 * chose back at them is not.
 */
function inspectAndClean(buf, category) {
  const spec = DOC_TYPES[category];
  const accept = spec ? spec.accept
    : ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  const maxBytes = spec ? spec.maxBytes : 20 * 1024 * 1024;

  if (!buf || !buf.length) return { ok: false, error: 'The file was empty.' };
  if (buf.length > maxBytes) {
    return { ok: false, error: `That file is ${(buf.length / 1048576).toFixed(1)}MB. The limit is ${Math.round(maxBytes / 1048576)}MB — please choose a smaller one.` };
  }

  // WHAT IT IS, not what it is called.
  const seen = IMG.sniff(buf);
  if (!seen) {
    return { ok: false, error: 'We could not tell what kind of file that is. Please upload a photo (JPG or PNG) or a PDF.' };
  }
  if (seen.mime === 'image/heic') {
    return { ok: false, error: 'That photo is in Apple’s HEIC format, which we cannot safely clean. On your iPhone: Settings → Camera → Formats → Most Compatible, then take or re-save the photo — or send it from Photos as a JPEG.' };
  }
  if (!accept.includes(seen.mime)) {
    const names = accept.map(m => ({ 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WebP', 'application/pdf': 'PDF' }[m] || m)).join(', ');
    return { ok: false, error: `A ${seen.ext.replace('.', '').toUpperCase()} file is not accepted here. Please upload: ${names}.` };
  }

  // CLEAN IT. An image we cannot clean does not get stored — the whole point of
  // asking for a photo of a child is that we are not also taking the family's
  // location, and "we tried" is not a defensible position for that.
  let out = buf, exifStripped = null, removed = [];
  if (seen.kind === 'image') {
    const r = IMG.strip(buf, seen.mime);
    if (!r.stripped) {
      return { ok: false, error: 'We could not read that image well enough to remove its hidden location data, so we have not stored it. Please try re-saving or re-taking the photo.' };
    }
    // Trust, then verify: the stripper says it ran; check the bytes agree.
    if (IMG.hasMetadata(r.buffer, seen.mime)) {
      return { ok: false, error: 'We could not fully remove the hidden data from that image, so we have not stored it. Please try a different photo.' };
    }
    out = r.buffer; exifStripped = true; removed = r.removed;
  }

  // A file whose header yields no size is not the image it claims to be,
  // whatever the first three bytes said.
  const dim = seen.kind === 'image' ? IMG.dimensions(out, seen.mime) : null;
  if (seen.kind === 'image' && (!dim || !dim.width || !dim.height)) {
    return { ok: false, error: 'That image looks damaged — we could not read its size. Please try another photo.' };
  }
  if (dim && PHOTO_CATEGORIES.includes(category) && (dim.width < 200 || dim.height < 200)) {
    return { ok: false, error: `That photo is only ${dim.width}×${dim.height} pixels — too small to print. Please send a larger one.` };
  }

  return {
    ok: true,
    buffer: out,
    mime: seen.mime,
    ext: seen.ext,
    width: dim ? dim.width : null,
    height: dim ? dim.height : null,
    exifStripped,
    removed,
    sha256: crypto.createHash('sha256').update(out).digest('hex'),
  };
}

// ── The allergy dead-end guard ───────────────────────────────────────────────

/**
 * Has this child a structured allergy anywhere the kitchen actually reads?
 *
 * BOTH boxes, because b314 proved one is not enough: children.allergies is the
 * Details field staff fill in, child_about_me.food_allergies is the one the
 * family fills in, and the kitchen day-sheet was reading only the first until
 * b314 fixed it. The literal string '{}' is checked because an empty
 * postgres-array-shaped value got written into that TEXT column historically —
 * the same guard kitchen.js uses.
 */
async function hasStructuredAllergy(db, childId) {
  const { rows } = await db.query(`
    SELECT COALESCE(NULLIF(NULLIF(TRIM(c.allergies), ''), '{}'), '')            AS clinical,
           COALESCE(NULLIF(TRIM(cam.food_allergies), ''), '')                   AS about_me
      FROM ${SCHEMA()}.children c
      LEFT JOIN ${SCHEMA()}.child_about_me cam ON cam.child_id = c.id
     WHERE c.id = $1`, [childId]);
  if (!rows.length) return true;                  // no child → raise nothing
  return !!(rows[0].clinical || rows[0].about_me);
}

/**
 * An allergy document has landed. If the structured field is empty, the chef's
 * day sheet does not know, and a PDF on a profile will not tell them. Raise a
 * task against the key person (managers if there is none).
 *
 * GDPR: the task title and description name NO child. `linked_id` carries the
 * child id and the board resolves the name for the staff member reading it —
 * tasks are read in Cockpit, exported, and in b311's signals, and a name baked
 * into a title travels everywhere the title does.
 *
 * Idempotent on source_ref so re-uploading does not produce a second task, and
 * silent on failure: a task that could not be written must not fail the upload
 * the parent just made.
 */
async function ensureAllergyTask(db, childId, docId, category) {
  if (!['allergy_doc', 'health_care_plan'].includes(category)) return null;
  try {
    if (await hasStructuredAllergy(db, childId)) return null;
    const ref = `b321-allergy:${childId}`;
    const { rows: dupe } = await db.query(
      `SELECT id FROM ${SCHEMA()}.tasks
        WHERE source='b321_allergy_doc' AND source_ref=$1 AND status IN ('open','in_progress')`, [ref]);
    if (dupe.length) return dupe[0].id;

    const { rows: kp } = await db.query(
      `SELECT key_person_id, room_id FROM ${SCHEMA()}.children WHERE id=$1`, [childId]);
    const owner = kp.length ? kp[0].key_person_id : null;

    const title = 'Record an allergy on a child profile';
    const body =
      'A family has uploaded allergy documentation, but this child has no allergy recorded '
      + 'in Details → Allergies or in All About Me → Food allergies.\n\n'
      + 'Until one of those is filled in, the allergy does NOT appear on the kitchen day sheet '
      + 'and the chef will not know. Open the profile, read the uploaded document, and type the '
      + 'allergy into the Details → Allergies field.';

    const { rows } = await db.query(
      `INSERT INTO ${SCHEMA()}.tasks
         (title, description, status, priority, due_date, owner_staff_id, created_by,
          source, source_ref, linked_to, linked_id, category)
       VALUES ($1,$2,'open','high', CURRENT_DATE, $3, NULL,
               'b321_allergy_doc', $4, 'children', $5, 'nursery')
       RETURNING id`,
      [title, body, owner, ref, childId]);
    const taskId = rows[0].id;

    // The notification body is under the same rule: no name, no document title.
    try {
      await db.query(
        `INSERT INTO ${SCHEMA()}.notifications
           (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
         VALUES ($1,$2,'allergy_doc',$3,$4,$5,'person_documents',$6,'high')`,
        [owner ? 'staff' : 'all-managers', owner || null,
         'Allergy document uploaded — no allergy recorded',
         'A family sent an allergy document for a child whose allergy field is empty. '
         + 'The kitchen day sheet will not show it until someone types it in.',
         `/child-profile.html?id=${childId}#documents`, docId]);
    } catch (e) { console.error('[b321] allergy notify failed:', e.message); }

    return taskId;
  } catch (e) {
    console.error('[b321] allergy task failed:', e.message);   // never a field value
    return null;
  }
}

module.exports = {
  DOC_TYPES, PHOTO_CATEGORIES, LEGACY_CLASS, CLASS_NOTE,
  classFor, inspectAndClean, hasStructuredAllergy, ensureAllergyTask,
};
