'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b263 — Tier 1: the sections nobody writes.
//
// Toby asked whether to pre-generate events/reminders in advance, or to attach a
// fixed block to every newsletter. The answer is both, but the split is by
// SOURCE, not by timing: pre-writing "events" months ahead makes them stale by
// the time they send, and Wren already holds that data. So:
//
//   Tier 1 (here)  assembled from live Wren data at COMPOSE time
//   Tier 2         the standing block — written once, edited rarely, renders LAST
//   Tier 3         the part a human writes, and the only part parents read
//
// Every block carries a `source` naming the table it came from and how many rows
// it found. That is not decoration: it means a wrong date gets fixed at source —
// in Events, in the term plan — instead of being patched into the newsletter text
// where the next newsletter will get it wrong again.
//
// CONSENT: any block naming a child goes through src/lib/newsletter-consent.js.
// The ungated child is filtered out before the block is built, so there is no
// point downstream at which an unconsented name exists to be rendered. Blocks
// report `consent_hidden` so the compose screen can say "3 hidden: no photo
// consent recorded" rather than quietly showing a shorter list.
// ─────────────────────────────────────────────────────────────────────────────

const { consentedChildIds, splitByConsent } = require('./newsletter-consent');
const { ymd, prettyDate } = require('./newsletter-cycle');
const planStatus = require('./plan-status');   // b290 — draft plans stay out of newsletters

// One helper so every block has the same shape and nothing invents its own.
function block(key, title, source, items, extra = {}) {
  return {
    key, title,
    source,                       // { table, description, count }
    items: items || [],
    empty: !(items && items.length),
    consent_hidden: extra.consent_hidden || 0,
    consent_reason: extra.consent_hidden ? 'no photo consent recorded' : null,
    ...extra,
  };
}

async function safe(db, sql, params, onError) {
  try { return (await db.query(sql, params)).rows; }
  catch (e) { console.error(`[b263 assemble] ${onError}:`, e.message); return null; }
}

/**
 * Build every tier-1 block for a half-term window.
 * `cycle.current` from resolveCycle() supplies the window.
 * Returns { window, blocks[], consent_hidden_total, unavailable[] }.
 */
async function assembleTier1(db, cycle, opts = {}) {
  // `current` already resolves to the upcoming period before the calendar
  // starts; `next` is the fallback for a caller that passed a bare cycle.
  const period = (cycle && (cycle.current || cycle.next)) || null;
  if (!period) {
    return { window: null, blocks: [], consent_hidden_total: 0,
             unavailable: ['No term period resolved — cannot assemble.'] };
  }
  const from = period.start_date, to = period.end_date;
  const roomId = opts.room_id || null;
  const allowedIds = await consentedChildIds(db);
  const unavailable = [];
  const blocks = [];
  let hiddenTotal = 0;

  // ── Dates for the half-term ────────────────────────────────────────────────
  blocks.push(block('dates', `Dates for ${period.name}`,
    { table: 'school_terms', description: `Ealing term dates${period.source ? ' — ' + period.source : ''}`, count: 1 },
    [{ label: 'Term starts', value: period.start_pretty, date: from },
     { label: 'Term ends',   value: period.end_pretty,   date: to }],
    { window: `${period.start_pretty} – ${period.end_pretty}` }));

  // ── What's on ──────────────────────────────────────────────────────────────
  const events = await safe(db, `
    SELECT id, title, description, event_date, start_time, end_time, location,
           audience, rsvp_required, capacity
      FROM events
     WHERE is_published = true
       AND event_date BETWEEN $1 AND $2
       AND (audience IS NULL OR audience IN ('all','parents'))
     ORDER BY event_date, start_time NULLS LAST`, [from, to], 'events');
  if (events === null) unavailable.push('events');
  else blocks.push(block('whats_on', "What's on",
    { table: 'events', description: 'published events for parents in this half-term', count: events.length },
    events.map(e => ({
      id: e.id, title: e.title, description: e.description || '',
      date: ymd(e.event_date), date_pretty: prettyDate(e.event_date),
      time: [e.start_time, e.end_time].filter(Boolean).join('–') || null,
      location: e.location || null,
      rsvp_required: !!e.rsvp_required, capacity: e.capacity || null,
    }))));

  // ── Trips ──────────────────────────────────────────────────────────────────
  const outings = await safe(db, `
    SELECT id, date, destination, purpose, learning_intention, transport_method
      FROM outings
     WHERE date BETWEEN $1 AND $2
       AND ($3::int IS NULL OR room_id = $3)
     ORDER BY date`, [from, to, roomId], 'outings');
  if (outings === null) unavailable.push('outings');
  else blocks.push(block('trips', 'Trips and outings',
    { table: 'outings', description: 'outings planned in this half-term', count: outings.length },
    outings.map(o => ({
      id: o.id, destination: o.destination,
      date: ymd(o.date), date_pretty: prettyDate(o.date),
      purpose: o.purpose || null,
      learning_intention: o.learning_intention || null,
      transport: o.transport_method || null,
    }))));

  // ── This half-term's theme + key books ─────────────────────────────────────
  // Prefer the plan bound to this school_term_id; fall back to matching on the
  // term name, which is how the older rows were keyed.
  //
  // b290 — a newsletter goes to parents, so only PUBLISHED plans qualify. A
  // half-term the room team is still drafting produces an empty block, which the
  // compose screen already renders as "nothing found for this window" — the
  // writer then either publishes the plan or writes the paragraph themselves.
  const planGate = await planStatus.publishedOnlySql(db, '');
  const plans = await safe(db, `
    SELECT id, room_id, term_name, theme, key_books, learning_intentions, songs
      FROM term_plans
     WHERE (school_term_id = ANY($1::int[]) OR term_name = $2)
       AND ($3::int IS NULL OR room_id = $3)
       AND theme IS NOT NULL AND theme <> ''${planGate}
     ORDER BY (school_term_id = ANY($1::int[])) DESC, room_id`,
    [period.school_term_ids, period.name, roomId], 'term_plans');
  if (plans === null) unavailable.push('term_plans');
  else blocks.push(block('theme', "What we're exploring this half-term",
    { table: 'term_plans', description: `theme and key books for ${period.name}`, count: plans.length },
    plans.map(p => ({
      id: p.id, room_id: p.room_id, term_name: p.term_name, theme: p.theme,
      key_books: Array.isArray(p.key_books) ? p.key_books : [],
      songs: Array.isArray(p.songs) ? p.songs : [],
      learning_intentions: Array.isArray(p.learning_intentions) ? p.learning_intentions : [],
    }))));

  // ── New starters — CONSENT-GATED, first names only ────────────────────────
  // The only tier-1 block that names a child. Two defences, not one: the consent
  // gate decides WHO, and the projection decides WHAT — first name and room, no
  // surname, no date of birth, no photo. A newsletter does not need more.
  const starters = await safe(db, `
    SELECT c.id, c.first_name, c.start_date, r.name AS room_name
      FROM children c
 LEFT JOIN rooms r ON r.id = c.room_id
     WHERE c.is_active = true
       AND c.start_date BETWEEN $1 AND $2
       AND ($3::int IS NULL OR c.room_id = $3)
     ORDER BY c.start_date, c.first_name`, [from, to, roomId], 'children (new starters)');
  if (starters === null) unavailable.push('children');
  else {
    const gated = splitByConsent(starters, allowedIds);
    hiddenTotal += gated.hiddenCount;
    blocks.push(block('new_starters', 'New faces joining us',
      { table: 'children.start_date', description: 'children who started in this half-term', count: starters.length },
      gated.allowed.map(c => ({
        id: c.id, first_name: c.first_name,          // first name ONLY, by design
        room: c.room_name || null,
        start_date: ymd(c.start_date),
      })),
      { consent_hidden: gated.hiddenCount, total_before_consent: starters.length }));
  }

  // ── On the menu ────────────────────────────────────────────────────────────
  const menu = await safe(db, `
    SELECT DISTINCT r.id, r.name, r.description, r.tags
      FROM menu_plans mp
      JOIN menu_recipes r ON r.id = mp.recipe_id
     WHERE mp.week_start_date BETWEEN $1 AND $2
       AND r.is_published = true
     ORDER BY r.name`, [from, to], 'menu_plans/menu_recipes');
  if (menu === null) unavailable.push('menu_plans');
  else blocks.push(block('menu', 'On the menu',
    { table: 'menu_plans → menu_recipes', description: 'dishes planned in this half-term', count: menu.length },
    menu.map(m => ({ id: m.id, name: m.name, description: m.description || null,
                     tags: Array.isArray(m.tags) ? m.tags : [] }))));

  // ── Funding reminders ──────────────────────────────────────────────────────
  // The date that matters to a parent is when the NEXT funding period starts, so
  // look forward past the end of this window rather than only inside it.
  //
  // Keyed on start_date, NOT funding_eligible_date: only 1 of 21 rows has an
  // eligibility date and it is in the past, so gating on it produced a block
  // that could never populate — a section that is permanently empty reads as
  // "nothing to report" when it actually means "wrong column". The epoch rows
  // are the EyMan import's undated placeholders and are excluded by date.
  const funding = await safe(db, `
    SELECT id, name, start_date, end_date, funding_eligible_date
      FROM funding_terms
     WHERE start_date > DATE '2000-01-01'
       AND start_date BETWEEN ($1::date - INTERVAL '14 days')
                          AND ($2::date + INTERVAL '120 days')
     ORDER BY start_date
     LIMIT 4`, [from, to], 'funding_terms');
  if (funding === null) unavailable.push('funding_terms');
  else blocks.push(block('funding', 'Funding — dates to know',
    { table: 'funding_terms', description: 'funding periods starting in or just after this half-term', count: funding.length },
    funding.map(f => ({
      id: f.id, name: f.name,
      term_starts: ymd(f.start_date), term_starts_pretty: prettyDate(f.start_date),
      term_ends: ymd(f.end_date), term_ends_pretty: prettyDate(f.end_date),
      eligible_by: ymd(f.funding_eligible_date),
      eligible_by_pretty: f.funding_eligible_date ? prettyDate(f.funding_eligible_date) : null,
    }))));

  return {
    window: { name: period.name, from, to,
              pretty: `${period.start_pretty} – ${period.end_pretty}` },
    blocks,
    consent_hidden_total: hiddenTotal,
    consented_children: allowedIds.size,
    unavailable,
  };
}

module.exports = { assembleTier1, block };
