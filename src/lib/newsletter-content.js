'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b263 — the section catalogue, the ordering rule, and the standing block.
//
// ── ORDER: TIER 3 → TIER 1 → TIER 2. Warm first, practical last. ─────────────
// The research on setting newsletters is blunt: they die when they open with
// reminders. What parents actually read is what their children have been doing.
// So the human-written part leads, the assembled practical detail follows, and
// the standing block — the bit that is the same every time — goes at the very
// end where it can be skimmed or ignored without costing anything.
//
// `sortWeight` below is the ONLY place that order is expressed. Sections carry
// section_order in the database as usual, but it is derived from here on
// assembly, so a new section type cannot accidentally land in the middle of the
// newsletter by being inserted at the wrong moment.
//
// ── ONE ASK PER NEWSLETTER, AND ONLY ONE ─────────────────────────────────────
// Five asks is zero asks. `singleton: true` on the `ask` type is enforced in the
// route: setting a new ask REPLACES the existing one rather than appending, so
// "exactly one" is a property of the data, not a thing someone has to remember.
// ─────────────────────────────────────────────────────────────────────────────

const STANDING_BLOCK_KEY = 'newsletter_standing_block';

// tier 3 = written by a person · tier 1 = assembled from Wren · tier 2 = standing
const SECTION_TYPES = [
  // ── Tier 3 — the newsletter itself ─────────────────────────────────────────
  { type: 'intro',           tier: 3, sortWeight: 10,  label: "Toby's introduction",
    help: 'A few lines in your own voice. This is what gets read first.' },
  { type: 'what_weve_been',  tier: 3, sortWeight: 20,  label: "What the children have been doing",
    help: 'Plain language, no jargon. The heart of the newsletter.' },
  { type: 'ask',             tier: 3, sortWeight: 30,  label: 'This half-term’s one ask',
    singleton: true,
    help: 'ONE concrete invitation — a photo of someone who looks after you, a phrase in your home language, come to a stay-and-play. Exactly one, or it becomes noise.' },
  { type: 'you_said_we_did', tier: 3, sortWeight: 40,  label: 'You said, we did',
    help: 'Closing the loop publicly is the most credible partnership signal a small setting has.' },
  { type: 'spotlight',       tier: 3, sortWeight: 50,  label: 'Practitioner spotlight',
    help: 'With 40 families, parents can actually know all the staff. Use that.' },
  { type: 'team_learning',   tier: 3, sortWeight: 60,  label: 'What the team is learning',
    help: 'One short paragraph from this half-term’s CPD deep-dive theme. Parents rarely see that a setting invests in its staff.' },
  { type: 'try_at_home',     tier: 3, sortWeight: 70,  label: 'One thing to try at home',
    help: 'Drawn from the activity library and tied to this half-term’s theme, so it connects to what the children are actually doing.' },

  // ── Tier 1 — assembled from Wren, nobody writes these ──────────────────────
  { type: 'theme',           tier: 1, sortWeight: 100, label: "What we're exploring", assembled: true },
  { type: 'new_starters',    tier: 1, sortWeight: 110, label: 'New faces joining us', assembled: true, consent_gated: true },
  { type: 'whats_on',        tier: 1, sortWeight: 120, label: "What's on", assembled: true },
  { type: 'trips',           tier: 1, sortWeight: 130, label: 'Trips and outings', assembled: true },
  { type: 'menu',            tier: 1, sortWeight: 140, label: 'On the menu', assembled: true },
  { type: 'dates',           tier: 1, sortWeight: 150, label: 'Dates for the half-term', assembled: true },
  { type: 'funding',         tier: 1, sortWeight: 160, label: 'Funding — dates to know', assembled: true },

  // ── Tier 2 — the standing block, always last ───────────────────────────────
  { type: 'standing_block',  tier: 2, sortWeight: 900, label: 'The usual reminders',
    singleton: true,
    help: 'Written once, edited rarely, renders last. Keep it to one screen.' },
];

const TYPE_BY_KEY = Object.fromEntries(SECTION_TYPES.map(t => [t.type, t]));
const SINGLETON_TYPES = new Set(SECTION_TYPES.filter(t => t.singleton).map(t => t.type));

// Unknown types keep working (the pre-b263 'text'/'card'/'cta' sections are
// untyped by this catalogue) and sort between tier 1 and the standing block.
function sortWeight(type) {
  return TYPE_BY_KEY[type] ? TYPE_BY_KEY[type].sortWeight : 200;
}

// ── The standing block ───────────────────────────────────────────────────────
// Toby's "specific part attached to every newsletter". Stored as one settings
// row, not a table: it is a single document with a single owner. `last_reviewed`
// is the point of it — a standing block with no review date quietly goes stale
// and starts telling parents something that stopped being true a year ago.
const DEFAULT_STANDING_BLOCK = {
  items: [
    { heading: 'Spare clothes',   text: 'Please keep two full changes of clothes in your child’s bag, named. We get through more than you would think.' },
    { heading: 'Sun cream',       text: 'From April to September please apply sun cream before drop-off. We reapply after lunch — you can record your consent in the app under Consents.' },
    { heading: 'Allergies & medicine', text: 'Tell us straight away if anything changes. Medicine can only be given with a signed form, and we cannot accept anything unlabelled.' },
    { heading: 'Booking & absence', text: 'Let us know about absence through the app — it goes straight onto the register. For changes to your booked days, speak to Toby.' },
    { heading: 'Who to talk to',  text: 'Day-to-day, your child’s key person. Anything bigger — fees, bookings, a concern — come to Toby or the deputy. We would always rather hear it early.' },
  ],
  last_reviewed: null,
  reviewed_by: null,
};

async function getStandingBlock(db) {
  try {
    const { rows } = await db.query('SELECT value, updated_at FROM settings WHERE key=$1', [STANDING_BLOCK_KEY]);
    if (!rows.length || !rows[0].value) {
      return { ...DEFAULT_STANDING_BLOCK, is_default: true, stale: true,
               stale_reason: 'Never reviewed — this is the starting text, not yours yet.' };
    }
    const v = JSON.parse(rows[0].value);
    const items = Array.isArray(v.items) ? v.items : DEFAULT_STANDING_BLOCK.items;
    const reviewed = v.last_reviewed || null;
    // Six newsletters a year; a standing block unreviewed for a year is stale.
    let stale = true, reason = 'Never reviewed.';
    if (reviewed) {
      const age = (Date.now() - new Date(reviewed).getTime()) / 86400000;
      stale = age > 365;
      reason = stale ? `Last reviewed ${Math.round(age)} days ago.` : null;
    }
    return { items, last_reviewed: reviewed, reviewed_by: v.reviewed_by || null,
             is_default: false, stale, stale_reason: reason };
  } catch (e) {
    console.error('[b263 standing] read failed:', e.message);
    return { ...DEFAULT_STANDING_BLOCK, is_default: true, stale: true,
             stale_reason: 'Could not be read.' };
  }
}

async function setStandingBlock(db, items, staffId) {
  const clean = (Array.isArray(items) ? items : [])
    .map(i => ({ heading: String(i.heading || '').slice(0, 120).trim(),
                 text: String(i.text || '').slice(0, 2000).trim() }))
    .filter(i => i.heading || i.text);
  const payload = {
    items: clean,
    last_reviewed: new Date().toISOString().slice(0, 10),
    reviewed_by: staffId || null,
  };
  await db.query(`
    INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `, [STANDING_BLOCK_KEY, JSON.stringify(payload), staffId || null]);
  return { ...payload, is_default: false, stale: false, stale_reason: null };
}

module.exports = {
  SECTION_TYPES, TYPE_BY_KEY, SINGLETON_TYPES, sortWeight,
  STANDING_BLOCK_KEY, DEFAULT_STANDING_BLOCK, getStandingBlock, setStandingBlock,
};
