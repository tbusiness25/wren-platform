'use strict';
/**
 * termly-planning.js — b277 (2026-09-04)
 *
 * The half-term's planning, as a parent-facing section of the termly update.
 *
 * Toby, 2026-09-04: "puts it into a termly update document along with the terms
 * planning".
 *
 * ── WHY THIS SECTION EXISTS ─────────────────────────────────────────────────
 * b246's five sections are all about the child. Read alone they say what a child
 * did without saying what was on offer — a parent learns their daughter enjoyed
 * the sensory tray but not that the room spent six weeks on Animals and
 * Habitats, read three named books and worked to five stated intentions. The
 * planning is the context that makes the rest legible, and the setting has
 * already written it: ladn.term_plans, populated properly by b276 from Toby's
 * own yearly plan.
 *
 * ── NEVER MODELLED ──────────────────────────────────────────────────────────
 * Same rule as b246's sections 3 and 5. This is the setting's own published
 * curriculum: a theme, named books, named songs, stated intentions. Handing it
 * to a model to "write up" could only make it less true. Every line below is
 * assembled from the row.
 *
 * ── MATCHING A PLAN TO A CYCLE ──────────────────────────────────────────────
 * In order, stopping at the first hit:
 *
 *   1. school_term_id = the cycle's half-term id      ← b276 populates this
 *   2. term_name + academic_year = the cycle's        ← older rows (b245 import)
 *   3. term_name only, most recent academic_year      ← a plan written before the
 *                                                       calendar row existed
 *
 * Rule 3 is deliberately last and is reported as a weaker match, because it can
 * pick up last year's Autumn 1. `matched_by` is carried onto the document so a
 * practitioner reviewing it can see which rule fired.
 *
 * ── AN UNPLANNED HALF-TERM IS SAID, NOT HIDDEN ──────────────────────────────
 * b276 gives Summer 2 2026-27 a deliberately empty row flagged
 * plan_source='not-planned:…' so that "nobody has planned this" is visible
 * rather than looking like "nobody has opened the screen". This module honours
 * that: an empty or not-planned row produces NO section at all rather than a
 * heading over nothing. A parent should never receive "Theme: —".
 *
 * ── AND A DRAFT IS NOT A PLAN (b290, 2026-09-08) ────────────────────────────
 * Toby: "add all the planning to wren as drafts … then the staff can edit and
 * then publish." A half-term still in draft is not eligible for any of the three
 * matching rules — the section is simply absent, exactly as it is for a
 * not-planned row. The alternative, printing the draft with a "draft" label,
 * puts unfinished planning in a parent's hands and invites the reply "you said
 * you were doing X"; a heading that is not there yet says less and is true.
 */

const planStatus = require('./plan-status');   // b290 — a draft plan is not published to a parent

// b302 (2026-09-10) — ONE reader, everywhere. intentionList/eventList used to
// live in this file, and Roost and EY each grew their own slightly different
// copy; the two that read `intentions` rather than `learning_intentions` showed
// an empty section against a complete plan. The resolution now lives in
// src/lib/term-plan-view.js and this module reads through it, so the parents
// document and the staff screens cannot drift apart again. Behaviour here is
// unchanged — the flat text[] still wins, which is what b277 shipped.
const planView = require('./term-plan-view');

const arr = planView.arr;
const intentionList = planView.intentionList;
const eventList = planView.eventList;

/** True when the row exists but holds no plan — b276's "not planned" marker. */
const isUnplanned = planView.isUnplanned;

/**
 * The half-term's plan for one room.
 *
 * @param {object} db      pg pool
 * @param {number} roomId  the CHILD's room. A child with no room gets no
 *                         planning section rather than another room's plan.
 * @param {object} cycle   from src/lib/termly-cycle.js
 * @returns {Promise<object|null>} the plan, or null when there is nothing to say
 */
async function loadTermPlan(db, roomId, cycle) {
  if (!roomId || !cycle) return null;

  const cols = `id, room_id, term_name, academic_year, school_term_id, theme,
                key_books, songs, learning_intentions, intentions, events,
                plan_source, framework, carry_forward`;

  // b290 — the termly update goes to a PARENT, so a draft plan is not a
  // candidate for any of the three rules below. The gate is applied inside each
  // query rather than to the result: without it, rule 1 would find the draft,
  // return it, and the document would silently have no planning section even
  // though a published plan for the same half-term existed under rule 2.
  const gate = await planStatus.publishedOnlySql(db, '');

  // 1 — the calendar id. Exact, and immune to a renamed half-term.
  if (cycle.half_term_id) {
    const { rows } = await db.query(
      `SELECT ${cols} FROM term_plans
        WHERE room_id = $1 AND school_term_id = $2${gate} ORDER BY id DESC LIMIT 1`,
      [roomId, cycle.half_term_id]);
    if (rows.length) return shape(rows[0], 'school_term_id');
  }

  // 2 — name + year. What the b245-era rows have.
  {
    const { rows } = await db.query(
      `SELECT ${cols} FROM term_plans
        WHERE room_id = $1 AND lower(trim(term_name)) = lower(trim($2))
          AND academic_year = $3${gate}
        ORDER BY id DESC LIMIT 1`,
      [roomId, cycle.name || '', cycle.academic_year || '']);
    if (rows.length) return shape(rows[0], 'term_name+year');
  }

  // 3 — name alone, newest year. Weaker: this can be last year's plan, and it
  // says so, so the review screen can show the year it actually found.
  {
    const { rows } = await db.query(
      `SELECT ${cols} FROM term_plans
        WHERE room_id = $1 AND lower(trim(term_name)) = lower(trim($2))${gate}
        ORDER BY academic_year DESC NULLS LAST, id DESC LIMIT 1`,
      [roomId, cycle.name || '']);
    if (rows.length) return shape(rows[0], 'term_name');
  }

  return null;
}

function shape(row, matchedBy) {
  const plan = {
    id: row.id,
    room_id: row.room_id,
    term_name: row.term_name,
    academic_year: row.academic_year,
    school_term_id: row.school_term_id || null,
    theme: String(row.theme || '').trim() || null,
    key_books: arr(row.key_books),
    songs: arr(row.songs),
    intentions: intentionList(row),
    events: eventList(row),
    carry_forward: String(row.carry_forward || '').trim() || null,
    plan_source: row.plan_source || null,
    matched_by: matchedBy,
  };
  plan.unplanned = isUnplanned(row);
  return plan;
}

/**
 * The section body a parent reads. Plain text, because that is what
 * src/lib/report-pdf.js renders and what b246's sections are.
 *
 * Returns '' when there is nothing true to print — the caller then marks the
 * section a placeholder and printableSections() drops it.
 */
function renderPlanning(plan, cycle, roomName, childName) {
  if (!plan || plan.unplanned) return '';
  const lines = [];
  const room = String(roomName || '').trim();
  const who = String(childName || '').trim();
  const term = (cycle && cycle.label) || (plan.term_name || 'this half-term');

  // No pronoun for the child anywhere in this file — Wren does not record one,
  // and a guessed "his"/"her" on a document going to a family is worse than the
  // name repeated. Where the name is unknown the sentence drops that clause.
  const opener = room
    ? `Here is what ${room} has been working on this half-term`
      + (who ? `, so you can see ${who}'s learning in context.` : '.')
    : 'Here is what the room has been working on this half-term.';
  lines.push(opener);
  lines.push('');

  if (plan.theme) lines.push(`Our theme for ${term} has been "${plan.theme}".`);

  if (plan.intentions.length) {
    lines.push('');
    lines.push('What we set out to do:');
    for (const i of plan.intentions) lines.push(`• ${i}`);
  }

  if (plan.key_books.length) {
    lines.push('');
    lines.push(plan.key_books.length === 1
      ? `Our key book has been ${plan.key_books[0]}.`
      : `Our key books have been: ${plan.key_books.join(', ')}.`);
  }

  if (plan.songs.length) {
    lines.push('');
    lines.push(plan.songs.length === 1
      ? `The song we have sung most is ${plan.songs[0]}.`
      : `Songs and rhymes we have sung: ${plan.songs.join(', ')}.`);
  }

  if (plan.events.length) {
    lines.push('');
    lines.push('Things that happened this half-term:');
    for (const e of plan.events) lines.push(`• ${e.title}${e.date ? ` (${e.date})` : ''}`);
  }

  // The year is only worth saying when rule 3 matched and it might be the wrong
  // one — otherwise it is noise on a document for a family.
  if (plan.matched_by === 'term_name' && plan.academic_year) {
    lines.push('');
    lines.push(`(From the ${plan.academic_year} plan for ${plan.term_name}.)`);
  }

  return lines.join('\n').trim();
}

/** What a practitioner is told when there is no plan to attach. */
function planningGap(plan, cycle, roomName) {
  const term = (cycle && cycle.label) || 'this half-term';
  if (!plan) {
    return `No term plan is saved for ${roomName || 'this room'} for ${term}, so this update has no `
         + 'planning section. Fill it in under Planning → Termly plan and redraft.';
  }
  if (plan.unplanned) {
    return `${term} is marked "not yet planned" for ${roomName || 'this room'}, so there is nothing to `
         + 'show a parent yet. Fill it in under Planning → Termly plan and redraft.';
  }
  return '';
}

module.exports = { loadTermPlan, renderPlanning, planningGap, isUnplanned, intentionList, eventList };
