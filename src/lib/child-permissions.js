'use strict';
/**
 * child-permissions.js — b265 (2026-09-01)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE canonical catalogue of the registration permissions, in one place, so the
 * enquiry form, the parents portal, the Roost consent screens and the media
 * gate cannot drift apart. Everything downstream reads this file.
 *
 * WHY THIS EXISTS
 * ---------------
 * The signed terms say:
 *
 *   "By registering your child you give permission for the following, unless
 *    written notice is given stating otherwise"
 *
 * That is OPT-OUT: permission is granted at registration and withdrawn by
 * notice. Wren had stored the opposite — child_consents held 92 rows, every one
 * granted=false, and children.photo_consent was false for 246 of 247 children.
 * The database said "no" for families who, per the terms they agreed, said yes.
 *
 * This catalogue encodes the real position: `mandatory` items default to
 * GRANTED at registration; `optional` items default to NOTHING (null) because
 * they are a genuine choice and an unanswered question is not a "no".
 *
 * STORE
 * -----
 * Canonical store is child_consents (child_id, consent_type, granted,
 * consent_date, source, updated_by, notes). The legacy booleans
 * children.photo_consent / children.media_consent are kept in step — see
 * `legacy` below and the trigger described in
 * scripts/b265-consent-schema.sql. Do NOT add a third store.
 *
 * SOURCE, recorded honestly
 * -------------------------
 *   registration    — the family registered; the terms grant it (opt-out items)
 *                     or they made a choice on the form (optional items)
 *   parent_portal   — the family changed it themselves in the parents portal
 *   written_notice  — a manager recorded a written withdrawal/grant from the family
 *   manager         — a manager set it in Roost without notice from the family
 *   imported        — carried in from EyLog or another system; evidence unknown
 *   migrated        — what the pre-b265 migration wrote. All 92 rows on production
 *                     carry this, all granted=false, and nobody decided any of
 *                     them. Evidence: none.
 *   parent          — legacy value predating b265 (kept so old rows still read)
 *
 * A permission that came from the terms is NOT the same evidence as one a
 * parent ticked, and the report in scripts/consent-reconciliation.js counts
 * them separately for exactly that reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Sources ──────────────────────────────────────────────────────────────────
const SOURCES = ['registration', 'parent_portal', 'written_notice', 'manager', 'admin', 'imported', 'migrated', 'parent'];
const SOURCE_SET = new Set(SOURCES);

/**
 * How much evidence a source represents. Used by the reconciliation report to
 * separate "a family actually told us" from "nobody ever set this".
 *   explicit — a person made this choice and we can point at when
 *   terms     — implied by the signed terms at registration
 *   unknown   — imported or legacy; we cannot say who decided it
 */
const SOURCE_EVIDENCE = {
  parent_portal: 'explicit',
  written_notice: 'explicit',
  manager: 'explicit',
  registration: 'terms',
  imported: 'unknown',
  migrated: 'unknown',
  parent: 'unknown',
};

// ── The catalogue ────────────────────────────────────────────────────────────
// b340 (2026-09-18) — the split was redrawn on Toby's word. What a family can NOT
// switch off is what the nursery cannot run without: we do not leave a member of
// staff behind with one child (outings), and photographs — including group
// photographs that reach other families — are how a learning journey works. What
// is a real choice is anything given to the child's body or worn on it: Calpol,
// a sunhat, sun cream, nappy cream, teething gel — and marketing, which we do not
// currently do at all. Calpol and the sunhat moved from mandatory to optional.
// No stored answer was rewritten: child_consents is untouched by this file.
//
// category: 'mandatory' → not offered as a switch; withdrawn only by talking to
//                         the office, which records it (Roost → source written_notice)
//           'optional'  → a real per-child yes/no, no default
//
// in_accepted_terms (mandatory only): does the terms-and-conditions text a family
//   accepts ACTUALLY say this? It is false for all three, checked against the live
//   T&Cs (prod policy 69, v1.1, 2026-09-15): they say outings need "parental consent
//   being obtained" and that photographs and off-site outings are "separate consents
//   … not covered by your acceptance of these terms". The parents screen may only
//   say "part of your terms" for an item where this is true — flip it when the terms
//   are amended, not before. See sectionCopy() below.
// default_granted: what a registration writes when the family says nothing
// consequence: what actually follows from a "no" — shown on the form and in the
//              portal. Toby: "if they dont bring their own suncream or sunhat
//              and its sunny we cant have them as they cant go outside."
// withdrawable_in_portal: the family can change it themselves at any time
//              (rather than only "by written notice"). True for every OPTIONAL
//              item. b340: false for the three mandatory ones — they are not
//              switches; a family who objects tells the office and a manager
//              records it.
const CONSENT_TYPES = [
  // ── Array order is display order, NOT the grouping — `category` is. (b340: Calpol and the sunhat sit
  //    among the stated items by sort_order but are optional; the screens group by category.) ──────────
  {
    key: 'calpol_high_temp',
    label: 'Calpol for a high temperature',
    category: 'optional',            // b340: it is medicine — a real choice, was 'mandatory'
    icon: '🌡️',
    help: 'We may give your child Calpol (infant paracetamol) if they develop a high temperature — '
        + 'but only after we have contacted you first. Children under 2 only.',
    detail: 'The condition is part of the permission: we ring you before anything is given. '
          + 'If we cannot reach you we will follow our sickness procedure and ask you to collect.',
    default_granted: null,           // b340: a registration writes nothing unless the family answered
    consequence: 'If you say no, we will not give Calpol at all — we will ring you and ask you to collect '
               + 'your child if their temperature is high.',
    withdrawable_in_portal: true,
    sort_order: 10,
  },
  {
    key: 'outings_local_walks',
    label: 'Outings outside the nursery',
    category: 'mandatory',
    icon: '🚶',
    help: 'We take children out of the nursery as a group — to the park, the pet shop and around the local area. '
        + 'Children travel in buggies or wear wristbands, and staffing ratios are set for the outing.',
    detail: 'Outings are a normal part of the week here, not an occasional extra.',
    why: 'We cannot leave a member of staff behind with one child while the rest of the group is out.',
    in_accepted_terms: false,        // the live terms say "with parental consent being obtained"
    default_granted: true,
    consequence: 'If you opt out, your child stays at the nursery with a member of staff while their group is out.',
    withdrawable_in_portal: false,   // b340: not a switch — talk to the office
    sort_order: 20,
  },
  {
    key: 'nursery_sunhat',
    label: 'A nursery sunhat',
    category: 'optional',            // b340: worn on the child — a real choice, was 'mandatory'
    icon: '👒',
    help: 'On sunny days we will put a nursery-supplied sunhat on your child if they have not brought their own.',
    detail: 'Hats are washed between children. The NHS advises that head lice are spread by direct '
          + 'head-to-head contact, not by sharing hats — this is the question we are asked most often.',
    default_granted: null,           // b340: nothing written unless the family answered
    consequence: 'If you say no, please send your child in with their own sunhat every day. Without a hat we '
               + 'cannot take your child outside on a sunny day — and we cannot offer a place on a day we '
               + 'cannot take your child outside.',
    withdrawable_in_portal: true,
    sort_order: 30,
  },
  {
    key: 'photo_media',
    label: 'Photographs in the nursery and on outings',
    category: 'mandatory',
    icon: '📷',
    help: 'We take photographs of the children in the nursery and on outings, and display them on the walls here.',
    detail: 'These pictures are printed on site and the image files are deleted afterwards. They stay '
          + 'inside the building — they are not published anywhere.',
    why: 'Photographs are how we record your child\'s day, and children are very often photographed together.',
    in_accepted_terms: false,        // the live terms list photographs as a "separate consent"
    default_granted: true,
    legacy: 'photo_consent',
    consequence: 'If you opt out, your child will not appear in the photographs we display, and will not be '
               + 'in group pictures taken for the walls.',
    withdrawable_in_portal: false,   // b340: not a switch — talk to the office
    sort_order: 40,
  },
  {
    key: 'learning_journey_group',
    label: 'Group photos in the online learning journey',
    category: 'mandatory',
    icon: '👨‍👩‍👧',
    help: 'Children are photographed together during activities, so a picture in your child\'s online learning '
        + 'journey often has other children in it — and a picture of your child often appears in theirs.',
    why: 'A group photograph cannot be split up, so a picture in one child\'s journey often has other children in it.',
    in_accepted_terms: false,        // the live terms list photographs as a "separate consent"
    // b265: this is the one item on the mandatory list that is a disclosure to
    // OTHER FAMILIES. It was a two-tap switch in the parents portal.
    // b340 (Toby, 2026-09-18): it is not a switch any more — group photographs are
    // how the journey works — so a family who objects talks to the office, and a
    // manager records it in Roost (source written_notice). The ENFORCEMENT is
    // unchanged: a stored granted=false still stops this child's picture reaching
    // other families (parent-media-gate.js / observations.js read enforces_group_media),
    // including every answer a family set here before b340.
    detail: 'If you would rather your child\'s picture was not shown to the other families in the group, '
          + 'tell the office. We record it, and photographs your child appears in are then not shown to the '
          + 'other families; the observation still works for everyone else, without that picture.',
    default_granted: true,
    withdrawable_in_portal: false,
    enforces_group_media: true,   // ← drives the share-time suppression in observations.js
    consequence: 'If we agree to this for your child, photographs they appear in are not shown to other families. '
               + 'Your own child\'s journey is unchanged — you still see every photograph of your child.',
    sort_order: 50,
  },

  // ── Genuine per-child choices ──────────────────────────────────────────────
  {
    key: 'nappy_cream',
    label: 'Antiseptic nappy cream',
    category: 'optional',
    icon: '🧴',
    help: 'A reputable-brand antiseptic nappy cream, applied at nappy changes if your child has nappy rash.',
    default_granted: null,
    consequence: 'If you say no, please send in your own cream — otherwise we cannot treat nappy rash and can '
               + 'only tell you about it at pick-up.',
    withdrawable_in_portal: true,
    sort_order: 60,
  },
  {
    key: 'teething_gel',
    label: 'Teething gel',
    category: 'optional',
    icon: '🦷',
    help: 'A reputable-brand teething gel, applied when your child is uncomfortable with teething.',
    default_granted: null,
    consequence: 'If you say no, please send in your own gel if you would like one used.',
    withdrawable_in_portal: true,
    sort_order: 70,
  },
  {
    key: 'sunscreen',
    label: 'Nursery sun cream',
    category: 'optional',
    icon: '☀️',
    help: 'A reputable-brand high-factor sun cream, applied before we go outside on sunny days.',
    default_granted: null,
    consequence: 'If you say no you must send in your own sun cream every day. Without sun cream we cannot take '
               + 'your child outside on a sunny day — and we cannot offer a place on a day we cannot take '
               + 'your child outside.',
    withdrawable_in_portal: true,
    sort_order: 80,
  },
  {
    key: 'marketing_face',
    label: 'Photos in our marketing and on social media',
    category: 'optional',
    icon: '📣',
    // b340: said plainly, because it is true. Toby: "we don't actually have social media, so
    // we'd never use that." The permission exists so that if that ever changes we already
    // hold an honest answer, rather than having to ask every family at once.
    help: 'We do not have any social media accounts, and at the moment we do not use photographs of '
        + 'children in our marketing.',
    detail: 'We are asking now so that, if that ever changes, we already have your honest answer and would '
          + 'never use a picture of your child without it. It is entirely your choice and has no effect on '
          + 'your child\'s place — saying no changes nothing about their day here.',
    default_granted: null,
    legacy: 'media_consent',
    consequence: 'If you say no, we will not use any picture your child appears in for marketing.',
    withdrawable_in_portal: true,
    sort_order: 90,
  },
];

// ── Derived lookups ──────────────────────────────────────────────────────────
const TYPE_KEYS = new Set(CONSENT_TYPES.map(t => t.key));
const BY_KEY = Object.fromEntries(CONSENT_TYPES.map(t => [t.key, t]));
const MANDATORY_KEYS = CONSENT_TYPES.filter(t => t.category === 'mandatory').map(t => t.key);
const OPTIONAL_KEYS = CONSENT_TYPES.filter(t => t.category === 'optional').map(t => t.key);
const LEGACY_BY_KEY = Object.fromEntries(CONSENT_TYPES.filter(t => t.legacy).map(t => [t.key, t.legacy]));

// The consent that governs whether this child's image may reach other families.
// Exactly one type carries enforces_group_media; observations.js reads this
// constant rather than hard-coding the key.
const GROUP_MEDIA_KEY = (CONSENT_TYPES.find(t => t.enforces_group_media) || {}).key;

// ── Wording that must not drift ──────────────────────────────────────────────
// The honest sentence about what a nursery can and cannot control. Shown on the
// registration form and on the parents consent page. Famly publishes the same
// caveat plainly; a setting that tells families the truth about screenshots
// reads as more careful, not less.
const MEDIA_REALITY_NOTICE =
  'Photographs in the learning journey are shared in confidence between nursery families. '
  // 2026-10-28 (Toby): photos are no longer watermarked — the sentence no longer claims they are.
  + 'We can turn downloading off. We cannot stop someone taking a screenshot — no nursery app can, '
  + 'on any platform — so please treat photographs with other people\'s children in them as private.';

const DOWNLOAD_WARNING =
  'This photograph may show children other than your own. Please ask their family before you share it '
  + 'anywhere.';

// The terms sentence this whole model is built on. Rendered on the form so a
// family reads the basis, not just the list.
const OPT_OUT_BASIS =
  'By registering your child you give permission for the following, unless you tell us otherwise. '
  + 'You can change your choices at any time from the parents portal, and you can tell the office about anything else at any time.';

// Removed at Toby's instruction (b265): the old permission allowing staff to take
// photographs on ANOTHER family's phone to mark a birthday or a last day. The
// setting no longer does it, so the wording is gone rather than carried forward —
// deliberately not reproduced here either, because the b265 harness greps the
// source for it and a "do not reinstate" comment holding the exact sentence would
// be the one place it survived.
const REMOVED_PERMISSIONS = [
  { removed: 'b265', subject: 'photographs taken on another family\'s device for a birthday or last day',
    reason: 'The setting no longer does this. Do not reinstate.' },
];

// ── b340: the parents screen's two sections ──────────────────────────────────
// Where a family can read the terms — the Policies & Terms page in the parents app.
const TERMS_LINK = '/welcome/policies';

/**
 * The words above the two sections of /welcome/consents, in one place so the
 * screen, the API and the tests cannot drift.
 *
 * The first section is titled "Part of your terms" ONLY when every item in it is
 * actually in the terms a family accepts (`in_accepted_terms`). Today none is, so
 * it says what is true — how the nursery runs — and points at the terms without
 * claiming they contain it. Saying "part of the terms you accepted" beside a link
 * to terms that say the opposite would put a false statement in front of every
 * family. When the terms are amended (v1.2, six weeks' notice), flip the three
 * `in_accepted_terms` flags above and this reads as Toby asked for it.
 */
function sectionCopy() {
  const mand = CONSENT_TYPES.filter(t => t.category === 'mandatory');
  const inTerms = mand.length > 0 && mand.every(t => t.in_accepted_terms === true);
  return {
    terms_link: TERMS_LINK,
    in_terms: inTerms,
    terms: inTerms
      ? {
          title: 'Part of your terms',
          lead: 'These are part of the terms and conditions you accepted when you registered, so they are not '
              + 'switches. If one is a problem for your child, tell us and we will talk it through.',
        }
      : {
          title: 'How we run the nursery',
          lead: 'These are how the nursery works day to day, so they are not switches. If one is a problem '
              + 'for your child, tell us and we will talk it through.',
        },
    choices: {
      title: 'Your choices',
      lead: 'Tap Yes or No — your choice saves straight away and our team sees it immediately. '
          + 'Nothing here changes your child\'s place.',
    },
    problem_button: 'Tell us if this is a problem for your child',
  };
}

/** Whether a family can set this permission themselves in the parents app. */
function familyCanSet(key) {
  const t = BY_KEY[key];
  return !!t && t.category === 'optional';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The default `granted` a registration writes for a type (true / null). */
function defaultFor(key) {
  const t = BY_KEY[key];
  return t ? (t.default_granted === undefined ? null : t.default_granted) : null;
}

/** Public shape — everything a UI needs, nothing internal. */
function publicCatalogue() {
  return CONSENT_TYPES.map(t => ({
    key: t.key,
    label: t.label,
    category: t.category,
    icon: t.icon,
    help: t.help,
    detail: t.detail || null,
    why: t.why || null,
    in_accepted_terms: t.category === 'mandatory' ? t.in_accepted_terms === true : null,
    consequence: t.consequence || null,
    default_granted: t.default_granted === undefined ? null : t.default_granted,
    withdrawable_in_portal: !!t.withdrawable_in_portal,
    governs_group_media: !!t.enforces_group_media,
    sort_order: t.sort_order,
  })).sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * The rows a registration should write. `choices` is {key: true|false} for the
 * optional items the family answered; anything unanswered stays null so we
 * never record a decision nobody made.
 */
function registrationRows(choices) {
  const c = choices || {};
  return CONSENT_TYPES.map(t => {
    let granted;
    if (t.category === 'mandatory') {
      // opt-out: granted unless the family said otherwise on the form
      granted = (c[t.key] === false) ? false : true;
    } else {
      granted = (c[t.key] === true) ? true : (c[t.key] === false ? false : null);
    }
    return { consent_type: t.key, granted, source: 'registration' };
  }).filter(r => r.granted !== null);   // never write "we asked and got nothing"
}

module.exports = {
  CONSENT_TYPES,
  TYPE_KEYS,
  BY_KEY,
  MANDATORY_KEYS,
  OPTIONAL_KEYS,
  LEGACY_BY_KEY,
  GROUP_MEDIA_KEY,
  SOURCES,
  SOURCE_SET,
  SOURCE_EVIDENCE,
  MEDIA_REALITY_NOTICE,
  DOWNLOAD_WARNING,
  OPT_OUT_BASIS,
  REMOVED_PERMISSIONS,
  TERMS_LINK,
  sectionCopy,
  familyCanSet,
  defaultFor,
  publicCatalogue,
  registrationRows,
};
