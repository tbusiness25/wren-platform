'use strict';
/**
 * termly-watch-document.js — b277 (2026-09-04)
 *
 * The document the watcher assembles when a staff member completes a termly
 * update: their own words, the half-term's planning, the child's next steps and
 * where they are in the tracker.
 *
 * ── HOW THIS DIFFERS FROM b246's DRAFT, AND WHY IT MAY PUBLISH ITSELF ───────
 * b246 exists for the case where NOBODY has written anything: the local model
 * drafts five sections from the records and a named practitioner has to read,
 * edit and sign before a family sees a word of it. That gate is right, because
 * the prose is Wren's.
 *
 * b277 fires on the opposite case. The practitioner has ALREADY written the
 * update — that is the trigger. Wren's job is to package it: put their words
 * next to the room's plan, the child's live next steps and their tracker
 * position, and deliver it. So by default nothing here is modelled at all, and
 * the resulting document is the practitioner's own text plus four blocks of
 * facts out of the database.
 *
 * The rule that follows from that, and the one that keeps this honest:
 *
 *     A DOCUMENT WREN WROTE NEEDS A HUMAN TO APPROVE IT.
 *     A DOCUMENT A HUMAN WROTE DOES NOT.
 *
 * So `modelled` on the returned content decides the release path, mechanically:
 * with termly_watcher_ai_home_ideas off, nothing is modelled, `modelled` is
 * false and the watcher may publish. Turn it on and the "things to try at home"
 * section comes from the local model, `modelled` flips true, and the same
 * document goes to /ey/termly-update for review exactly like a b246 draft. The
 * watcher does not get to choose; it reads the flag this file sets.
 *
 * ── THE SECTIONS ────────────────────────────────────────────────────────────
 *   1  practitioner_update  the staff member's own update, verbatim   NEVER modelled
 *   2  term_plan            the half-term's planning (b276/term_plans) NEVER modelled
 *   3  next_steps           live ladn.next_steps                       NEVER modelled
 *   4  at_home              ideas for home           OPTIONAL, LOCAL MODEL ONLY
 *   5  tracking             ladn.framework_tracker                     NEVER modelled
 *
 * Section 1 is first on purpose. The person the family knows wrote it; the
 * context comes after, not before.
 *
 * ── SHAPE COMPATIBILITY ─────────────────────────────────────────────────────
 * content.kind stays 'termly_update' so every b246 surface — the review screen,
 * the PDF pipeline, the parents list, reports.shared_with_parents — treats this
 * as what it is. `variant:'watched'` and `section_order` tell b246's
 * printableSections()/sendProblems() which sections this document has; both were
 * patched in b277 to read section_order when it is present and to behave exactly
 * as before when it is not.
 *
 * ── SOVEREIGNTY ─────────────────────────────────────────────────────────────
 * The one optional model call goes through src/lib/sovereign-model.js, whose
 * assertLocalHost() refuses any host that is not a private / Tailscale / loopback
 * IP literal, at require time AND before every request. There is no provider
 * switch in this file, no API key read, and no fallback: if the Ascent is not
 * reachable the section is not written and the document says so. AI_PROVIDER is
 * deliberately never consulted — a demo edition pointed at Groq drafts locally
 * or not at all.
 */

const TU = require('./termly-update');
const TP = require('./termly-planning');

// Lazily required for the same reason as b246: sovereign-model.js asserts its
// host at REQUIRE time, so a bad OLLAMA_HOST would take down the mount rather
// than failing one section.
function sovereign() { return require('./sovereign-model'); }

// ai-models.js role 'heavy', resolved per call (b333). opts.model — the
// termly_watcher_model setting — still wins when it names one.
const ai = require('./ai-models');
const ROLE = 'heavy';
const TIMEOUT_MS = parseInt(process.env.TERMLY_UPDATE_TIMEOUT_MS || '300000', 10);

const SECTIONS = [
  { key: 'practitioner_update', heading: 'Your child\'s progress update',            modelled: false },
  { key: 'term_plan',           heading: 'What we have been doing this half-term', modelled: false },
  { key: 'next_steps',          heading: 'Next steps',                             modelled: false },
  { key: 'at_home',             heading: 'Things you could try at home',           modelled: true  },
  { key: 'tracking',            heading: 'Where things are in the tracker',        modelled: false },
];
const SECTION_ORDER = SECTIONS.map(s => s.key);

/**
 * The practitioner's completed update, read back out of ladn.observations.
 *
 * Only the parent-facing fields. `staff_notes` is explicitly NOT read: it is the
 * practitioner's private working note and putting it on a family's document
 * would be a disclosure, not a feature. `analysis` IS read — in EYFS practice
 * that is the "what this tells us" paragraph, written to be shared.
 */
async function loadCompletion(db, observationId) {
  const { rows } = await db.query(`
    SELECT o.id, o.child_id, o.staff_id, o.title, o.observation_text, o.analysis,
           o.next_steps, o.eyfs_areas, o.created_at, o.eylog_ref, o.termly_update,
           o.shared_with_parents,
           -- b296 — a progress update now carries these in the practitioner's own
           -- words. All three are parent-facing by definition (staff_notes, which
           -- is not, is still deliberately absent from this list).
           o.at_home_ideas, o.next_steps_home, o.closing_note,
           COALESCE(o.author_name, s.first_name || ' ' || s.last_name) AS author_name,
           s.role AS author_role
      FROM observations o
      LEFT JOIN staff s ON s.id = o.staff_id
     WHERE o.id = $1`, [observationId]);
  if (!rows.length) return null;
  const o = rows[0];
  return {
    id: o.id, child_id: o.child_id, staff_id: o.staff_id || null,
    title: String(o.title || '').trim() || null,
    text: String(o.observation_text || '').trim(),
    analysis: String(o.analysis || '').trim() || null,
    next_steps_text: String(o.next_steps || '').trim() || null,
    // b296 — the progress update's own sections. Null on anything written
    // before this build, and on an EyLog row, which is why every use below is
    // guarded rather than assumed.
    at_home_text: String(o.at_home_ideas || '').trim() || null,
    next_steps_home_text: String(o.next_steps_home || '').trim() || null,
    closing_note: String(o.closing_note || '').trim() || null,
    areas: Array.isArray(o.eyfs_areas) ? o.eyfs_areas : [],
    created_at: o.created_at,
    completed_on: TU.ymd(o.created_at),
    eylog_ref: o.eylog_ref || null,
    author_name: String(o.author_name || '').trim() || null,
    author_role: o.author_role || null,
  };
}

/**
 * Section 1 — the practitioner's words, and only theirs.
 *
 * Assembled, not rewritten. The one editorial act is joining the observation
 * text and the analysis with a blank line, and appending the next-steps
 * sentence the practitioner typed into the observation if they typed one.
 *
 * EyLog rows have no title at all (0 of 13,866 on prod), so a title is used when
 * it is there and silently skipped when it is not.
 */
function renderPractitionerUpdate(comp, ev) {
  if (!comp) return '';
  const parts = [];
  if (comp.title) parts.push(comp.title);
  if (comp.text) parts.push(comp.text);
  if (comp.analysis) parts.push(comp.analysis);
  if (comp.next_steps_text) parts.push(`What we will work on next: ${comp.next_steps_text}`);
  // b296 — the free-text box at the end of a progress update is the
  // practitioner's own closing paragraph, so it closes their section too.
  if (comp.closing_note) parts.push(comp.closing_note);
  const body = parts.join('\n\n').trim();
  if (!body) return '';

  const who = comp.author_name;
  const when = TU.longDate(comp.created_at);
  const sig = who
    ? `Written by ${who}${comp.author_role ? ', ' + TU.roleLabel(comp.author_role) : ''}${when ? ' on ' + when : ''}.`
    : (when ? `Written on ${when}.` : '');
  return sig ? `${body}\n\n${sig}` : body;
}

// ── Section 4, the one optional model call ───────────────────────────────────
const HOME_SYSTEM =
  'You are an early years practitioner at a nursery in England writing two or three ideas a '
+ 'family could try at home. Warm, plain English, no jargon and no EYFS codes. Every idea uses '
+ 'things already in an ordinary home. Never invent anything about the child that you were not '
+ 'given. Write nothing except the ideas.';

function homePrompt(ev, comp) {
  const name = ev.child.known_as || 'this child';
  const steps = (ev.open_next_steps || []).slice(0, 6)
    .map(n => `- ${n.description}`).join('\n') || '- (none recorded)';
  const interests = [
    ev.interests.interests && `Interests: ${ev.interests.interests}`,
    ev.interests.favourites && `Favourite things: ${ev.interests.favourites}`,
    ev.interests.tags.length && `Also enjoys: ${ev.interests.tags.join(', ')}`,
  ].filter(Boolean).join('\n') || '(nothing recorded)';

  return [
    `Write 2-3 ideas a family could try at home with ${name}.`,
    '',
    'What their key person wrote in this term\'s update:',
    (comp && comp.text ? comp.text.slice(0, 1500) : '(not recorded)'),
    '',
    `The next steps ${name} is working on:`,
    steps,
    '',
    `What ${name} enjoys:`,
    interests,
    '',
    'For each idea give: a short title on its own line, then "You need:" and household things, '
    + 'then 2-4 numbered steps, then a line starting "Tell us:" asking the family to share how it '
    + 'went. Tie every idea to a next step or an interest above. Nothing else.',
    '',
    'Here is the register to write in — the shape, not the content. Do not reuse these ideas:',
    TU.HOME_IDEA_EXAMPLES,
  ].join('\n');
}

/**
 * Assemble the document.
 *
 * @param {object} db
 * @param {object} opts
 *   @param {object} opts.cycle       from src/lib/termly-cycle.js
 *   @param {object} opts.completion  from termly-sources.detect* (the signal)
 *   @param {boolean} opts.aiHomeIdeas  settings.termly_watcher_ai_home_ideas
 *   @param {string} opts.on
 * @returns {Promise<object>} reports.content
 */
async function assemble(db, opts = {}) {
  const { cycle, completion } = opts;
  if (!cycle) throw new Error('No termly-update cycle for this date — the school term calendar does not cover it.');
  if (!completion) throw new Error('No completion signal — nothing to assemble a document from.');

  const on = TU.ymd(opts.on) || TU.ymd(new Date());

  // b246's evidence gatherer, unchanged and unforked. It is the thing that knows
  // how to keep last term and this term apart, and rewriting it here would be a
  // second copy of that judgement waiting to drift.
  const ev = await TU.gatherEvidence(db, completion.child_id, cycle, { on });
  const comp = await loadCompletion(db, completion.observation_id);
  const plan = await TP.loadTermPlan(db, ev.child.room_id, cycle);

  const name = ev.child.known_as || ev.child.first_name || 'Your child';
  const sections = [];
  const errors = [];
  let modelled = false;
  let host = null;

  // ── 1 · the practitioner's update ─────────────────────────────────────────
  const own = renderPractitionerUpdate(comp, ev);
  sections.push({
    key: 'practitioner_update', heading: SECTIONS[0].heading,
    body: own || `${name}'s key person marked this term's update as done, but the observation it was `
               + 'recorded on has no text in it. Open the update and write it before sending.',
    generated: false, source: completion.source, evidence: comp ? [`OBS-${comp.id}`] : [],
    placeholder: !own,
  });

  // ── 2 · the half-term's planning ──────────────────────────────────────────
  //
  // ⚠ AN EMPTY AUXILIARY SECTION IS EMPTY, NOT A PLACEHOLDER WITH WORDS IN IT.
  //
  // b246's sendProblems() blocks on any non-empty section still carrying the
  // drafter's "we have not recorded enough" text, and leaves an EMPTY one out
  // (rules 1 and 2 in that function). That is exactly right for b246, where
  // every section is Wren's prose and a gap means the draft is not finished.
  //
  // It is wrong here. A completed termly update whose room has no saved plan and
  // whose child has no open next steps is not an unfinished document — it is a
  // finished document with two fewer blocks of context. If the gap text went in
  // the body, those two sections would block the send and the family would
  // silently never receive an update their key person had written.
  //
  // So: the body is either the real thing or EMPTY, and the explanation goes in
  // `staff_note`, which printableSections() never prints. The practitioner sees
  // what is missing on the review screen; the parent sees one fewer heading.
  const planBody = TP.renderPlanning(plan, cycle, ev.child.room_name, name);
  sections.push({
    key: 'term_plan', heading: SECTIONS[1].heading,
    body: planBody,
    staff_note: planBody ? null : TP.planningGap(plan, cycle, ev.child.room_name),
    generated: false, placeholder: false,
    plan_id: plan ? plan.id : null,
    plan_matched_by: plan ? plan.matched_by : null,
  });

  // ── 3 · next steps ────────────────────────────────────────────────────────
  const suff = TU.sufficiency(ev);
  let stepsBody = suff.next_steps.sufficient ? TU.renderNextSteps(ev.open_next_steps, ev) : '';
  /* b296 — Toby split next steps into "at nursery" and "at home". The live
   * ladn.next_steps rows above are the nursery half and are unchanged; the home
   * half is what the practitioner typed on the progress update, so it is
   * appended verbatim rather than modelled or dropped. */
  if (comp && comp.next_steps_home_text) {
    stepsBody = (stepsBody ? stepsBody + '\n\n' : '')
      + `At home\n${comp.next_steps_home_text}`;
  }
  sections.push({
    key: 'next_steps', heading: SECTIONS[2].heading,
    body: stepsBody,
    staff_note: stepsBody ? null : TU.gapText('next_steps', ev),
    generated: false, sufficient: !!suff.next_steps.sufficient,
    evidence: ev.open_next_steps.map(n => n.ref),
    placeholder: false,
  });

  // ── 4 · ideas for home ────────────────────────────────────────────────────
  /* b296 — "What parents can do at home" is now a box the key person fills in on
   * the progress update, and Toby's reason for adding it was that it is "the
   * point of sending it". So when they have written it, that IS the section: it
   * is used verbatim and the model is never asked. A model rewriting a
   * practitioner's own words to a family would be worse than useless. The AI
   * path below is unchanged and still covers the case where the box is empty. */
  if (comp && comp.at_home_text) {
    sections.push({
      key: 'at_home', heading: SECTIONS[3].heading,
      body: comp.at_home_text,
      generated: false, placeholder: false, from_practitioner: true,
    });
  } else if (opts.aiHomeIdeas) {
    let body = '', generated = false;
    try {
      const sm = sovereign();
      host = sm.assertLocalHost(sm.OLLAMA);   // throws on anything not private/Tailscale
      if (!suff.at_home.sufficient) throw new Error('not enough recorded to write ideas from');
      const raw = await sm.generate({
        model: opts.model || ai.model(ROLE), system: HOME_SYSTEM, prompt: homePrompt(ev, comp),
        temperature: 0.2, numPredict: 620, timeoutMs: TIMEOUT_MS,
      });
      const checked = TU.checkCitations(raw, new Set(Object.keys(ev.index)));
      body = checked.text;
      if (!body) throw new Error('the local model returned nothing usable');
      generated = true;
      modelled = true;
    } catch (e) {
      errors.push(`at_home: ${e.message}`);
      body = `Ideas for home could not be written automatically (${e.message}). `
           + `${name}'s key person can add them.`;
    }
    sections.push({
      key: 'at_home', heading: SECTIONS[3].heading, body,
      generated, placeholder: !generated,
    });
  }

  // ── 5 · the tracker ───────────────────────────────────────────────────────
  // Same rule as sections 2 and 3: facts or nothing.
  const trackBody = suff.tracking.sufficient ? TU.renderTracking(ev) : '';
  sections.push({
    key: 'tracking', heading: SECTIONS[4].heading,
    body: trackBody,
    staff_note: trackBody ? null : TU.gapText('tracking', ev),
    generated: false, sufficient: !!suff.tracking.sufficient,
    evidence: ev.tracker.moved.slice(0, 20).map(m => m.ref),
    placeholder: false,
  });

  // The signature. This is the practitioner who completed the update — the whole
  // premise of publishing without a second review is that they already signed it
  // by doing it. When the source gave us no staff id (an EyLog row whose author
  // did not resolve to a Wren staff member) there is no name to put on it, and
  // canPublish() below refuses.
  const approved = comp && comp.author_name
    ? { name: comp.author_name, role: comp.author_role ? TU.roleLabel(comp.author_role) : null,
        staff_id: comp.staff_id, at: comp.created_at, via: 'termly-watcher' }
    : null;

  return {
    kind: 'termly_update',
    variant: 'watched',
    version: 1,
    section_order: SECTION_ORDER,
    status_note: null,
    cycle: {
      key: cycle.key, label: cycle.label, name: cycle.name,
      academic_year: cycle.academic_year,
      term_start: cycle.term_start, term_end: cycle.term_end,
      due_on: cycle.due_on, overdue_on: cycle.overdue_on,
      source: 'school_terms (Ealing)',
    },
    windows: ev.windows,
    child: ev.child,
    keyperson: ev.keyperson,
    sections,
    approved_by: approved,
    // The audit trail. No new table: this IS the record of why the document
    // exists, which input produced it and which row it came from.
    watcher: {
      build: 'b277',
      source: completion.source,
      matched_by: completion.matched_by,
      source_ref: completion.source_ref,
      observation_id: completion.observation_id,
      completed_on: completion.completed_on,
      completed_by_staff_id: completion.staff_id || null,
      due_on: cycle.due_on,
      on_time: completion.completed_on && cycle.due_on ? completion.completed_on <= cycle.due_on : null,
      assembled_at: new Date().toISOString(),
      assembled_on: on,
    },
    term_plan: plan ? {
      id: plan.id, room_id: plan.room_id, theme: plan.theme,
      term_name: plan.term_name, academic_year: plan.academic_year,
      key_books: plan.key_books, songs: plan.songs, intentions: plan.intentions,
      events: plan.events, matched_by: plan.matched_by,
      plan_source: plan.plan_source, unplanned: plan.unplanned,
    } : null,
    next_steps: {
      items: ev.open_next_steps.map(n => ({
        next_step_id: n.id, description: n.description, status: n.status,
        area: n.area, area_label: n.area_label, due_by: n.due_by,
        resource_card_slug: n.resource_card_slug, resource_card_title: n.resource_card_title,
        library_activity_id: n.library_activity_id, library_activity_name: n.library_activity_name,
      })),
    },
    tracking: {
      framework: ev.tracker.framework, total: ev.tracker.total,
      by_status: ev.tracker.by_status, areas: ev.tracker.areas,
      moved: ev.tracker.moved.slice(0, 40),
    },
    previous: ev.previous ? { id: ev.previous.id, cycle_key: ev.previous.cycle_key,
                              cycle_label: ev.previous.cycle_label, sent_at: ev.previous.sent_at } : null,
    evidence_index: ev.index,
    counts: ev.counts,
    sufficiency: suff,
    // THE FLAG THE RELEASE PATH TURNS ON. See the header.
    modelled,
    model: {
      host: host || null,
      model: modelled ? (opts.model || ai.model(ROLE)) : null,
      errors: errors.length ? errors : null,
      note: modelled
        ? 'The "things you could try at home" section was written on the setting\'s own hardware. '
          + 'No child data left the local network. Everything else is the key person\'s own words '
          + 'and the setting\'s own records.'
        : 'No AI was used. Every word of this update is the key person\'s own or comes straight '
          + 'from the setting\'s records.',
    },
  };
}

/**
 * Is this document allowed to go to a family without somebody reading it first?
 *
 * Four conditions, and every one of them is about provenance rather than
 * quality — quality is the practitioner's, and they already applied it.
 */
function canPublish(content) {
  const problems = [];
  if (!content) return { ok: false, problems: ['There is no document.'] };

  // 1 — nothing Wren wrote. This is the whole rule.
  if (content.modelled) {
    problems.push('A section of this update was written by the model, so a practitioner reviews it before it goes out.');
  }
  // 2 — somebody's name on it.
  const ap = content.approved_by || {};
  if (!String(ap.name || '').trim()) {
    problems.push('The observation this came from has no author Wren can name, so there is nobody to put on it.');
  }
  // 3 — the practitioner's own section actually has words in it.
  const own = (content.sections || []).find(s => s.key === 'practitioner_update');
  if (!own || !String(own.body || '').trim() || own.placeholder) {
    problems.push('The progress update itself is empty — there is nothing to send.');
  }
  // 4 — b246's own gate, which now understands this document's sections.
  for (const p of TU.sendProblems(content)) problems.push(p);

  return { ok: !problems.length, problems };
}

module.exports = {
  SECTIONS, SECTION_ORDER,
  loadCompletion, renderPractitionerUpdate, assemble, canPublish,
};
