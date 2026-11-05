'use strict';
/**
 * away-modes.js — b512 (2026-10-18)
 *
 * The six modes of the "when Toby's away" assistant (five consultants and, since
 * 2026-11-03, "Using Wren"), in one place:
 * what each one is for, which parts of the corpus it may read, what it will not
 * do, and the system prompt that says so.
 *
 * ── WHY THE MODES ARE DATA AND NOT PROMPTS SCATTERED IN A ROUTE ──────────────
 * Each mode has a different ORDER OF AUTHORITY, and that order is the whole
 * design — the same question gets a different right answer depending on which
 * document outranks which. HR is the clearest case (b318): the handbook is a
 * contractual document, so it comes first; the statutory position fills its
 * silences; and where the handbook is BELOW the legal minimum the answer is the
 * law plus a flag on the handbook paragraph. Nothing here rewrites a policy.
 *
 * ── WHAT NONE OF THEM MAY DO ─────────────────────────────────────────────────
 * Invent a policy. If the retrieved passages do not cover the question, the
 * answer is "nothing in the Bible or the policies covers this" and the route
 * logs a gap. That is enforced in the route (an empty retrieval never reaches
 * the model) as well as asked for here.
 *
 * ── CHILD AND FAMILY DATA ────────────────────────────────────────────────────
 * The corpus holds none: every chunk passes the reading room's family-data
 * guard at ingest. The prompts below say "never a case detail" because the
 * person asking may type one, and the answer must not build on it.
 */

// Priority weights per mode. A retrieved chunk's score is multiplied by the
// weight of its source_kind in the active mode, so the handbook outranks the
// Bible in HR mode and the Bible outranks everything in Away mode. A kind with
// no entry falls back to BASE_WEIGHT; a kind at 0 is not retrievable in that
// mode at all.
const BASE_WEIGHT = 0.9;

const EMERGENCY_NUMBERS = Object.freeze({
  emergency: '999',
  ofsted: '0300 123 1231',
  nursery: '020 7946 0000',
  mash: "Ealing children's social care / MASH — Ealing Council switchboard",
  lado: 'Ealing LADO (local authority designated officer)',
  urn: '',
});

// Phrases that must never produce a composed answer. Matched on the raw
// question, before any retrieval or model call. The reply is the redirect, with
// the numbers, and nothing else.
const EMERGENCY_PATTERNS = Object.freeze([
  { re: /\b(not breathing|unconscious|unresponsive|cpr|choking|chocking|cardiac|seizure|fitting|anaphyla|bleeding (?:badly|heavily)|severe bleed)\b/i,
    kind: 'medical', call: '999' },
  { re: /\b(?:call|calling|need|needs|phone)?\s*(?:an\s+)?ambulance\b/i, kind: 'medical', call: '999' },
  { re: /\b(fire|smoke|evacuat\w*|gas leak|smell(?:ing)? gas)\b/i, kind: 'fire', call: '999', retro: true },
  { re: /\b(child(?:'s| is)? (?:missing|gone|wandered off)|missing child|can'?t find (?:a|the) child|abduct\w*)\b/i,
    kind: 'missing-child', call: '999' },
  { re: /\b(intruder|break[- ]?in|broke in|assault\w*|threaten\w*(?: me| us| staff)|violent)\b/i,
    kind: 'police', call: '999', retro: true },
  // ── THE SAFEGUARDING DISCLOSURE PATTERN ─────────────────────────────────────
  // The evals caught the first version missing "a child has told me her dad
  // hurts her", because it required "told me (he|she|they) (was|were|had been)"
  // — a grammar no one under pressure types. A missed disclosure is the worst
  // failure this file can have, so this is deliberately WIDE: any "told me /
  // said / disclosed" near any harm word, and any family or carer word next to
  // any harm verb, in any tense.
  //
  // It will over-catch. That is the correct direction: the cost of over-catching
  // is one extra screen telling a manager to speak to the DSL and write it down,
  // which is advice they should follow anyway; the cost of under-catching is a
  // chatbot answering a disclosure. There is no `retro` escape on this one for
  // the same reason — a disclosure made last week is still a disclosure.
  { re: /\b(disclos\w+|sexual\w* (?:abus|assault|harm)|physical abuse|fgm|forced marriage|radicalis\w+|county lines|grooming|groomed|neglect(?:ed|ing)?)\b/i,
    kind: 'safeguarding', call: 'DSL now, then Ealing MASH' },
  { re: /\b(?:told me|told her|told him|said to me|has said|disclosed|came and said|whispered)\b[^.?!]{0,80}\b(hurt\w*|hit\w*|hits|smack\w*|beat\w*|punch\w*|kick\w*|burn\w*|touch\w*|scared|frightened|afraid|not safe|unsafe|shout\w* at (?:her|him|them)|lock\w*)\b/i,
    kind: 'safeguarding', call: 'DSL now, then Ealing MASH' },
  { re: /\b(dad|daddy|mum|mummy|mother|father|step-?dad|step-?mum|step-?father|step-?mother|uncle|aunt|grandad|grandma|nan|brother|sister|partner|boyfriend|girlfriend|carer|childminder)\b[^.?!]{0,40}\b(hurt\w*|hits|hit her|hit him|hit them|smack\w*|beat\w*|punch\w*|kick\w*|burn\w*|chok\w*|strangl\w*|lock\w* (?:her|him|them) (?:in|up)|touch\w* (?:her|him|them))\b/i,
    kind: 'safeguarding', call: 'DSL now, then Ealing MASH' },
  { re: /\bbeing\b[^.?!]{0,30}\b(hurt|hit|abused|touched|neglected|starved)\b/i,
    kind: 'safeguarding', call: 'DSL now, then Ealing MASH' },
  { re: /\ballegation\b.*\b(staff|adult|member of staff|volunteer|practitioner|colleague)\b|\b(staff|adult|volunteer|practitioner|colleague)\b.*\ballegation\b/i,
    kind: 'lado', call: 'the LADO today' },
]);

/**
 * Is the question plainly ABOUT SOMETHING THAT IS OVER?
 *
 * The evals caught "the fire alarm went off and we evacuated — what now" being
 * answered with "get everyone out, then call 999", which is useless and faintly
 * absurd: they are already out, and what they need is the notification and
 * recording steps.
 *
 * This only applies to the patterns marked `retro` (fire and police), and only
 * when the wording is unambiguously retrospective AND asks what to do next. It
 * is NOT applied to a medical emergency, a missing child, a safeguarding
 * disclosure or a LADO matter, because for those the right answer is the same
 * whether it happened five minutes ago or yesterday.
 *
 * And even when it fires, the composed answer still carries the safety line (see
 * safetyPrefix) — the redirect is downgraded, never dropped.
 */
const RETRO_RE = /\b(went off|has gone off|gone off|already|afterwards|yesterday|last (?:week|night|month|term)|we (?:have |'ve )?evacuated|we (?:are|'re) (?:all )?(?:out|outside)|everyone is out|has been dealt with|it'?s out now|put it out|all clear|false alarm)\b/i;
const NEXT_RE  = /\b(what now|what next|what do I do next|what happens now|afterwards|do I (?:have to |need to )?(?:report|record|tell|notify)|who do I (?:tell|notify|report)|paperwork|write up)\b/i;

function isRetrospective(q) { return RETRO_RE.test(q) && NEXT_RE.test(q); }

/**
 * The one-line safety note put at the TOP of an answer whose question tripped a
 * `retro` emergency pattern but was judged retrospective. The emergency advice
 * is downgraded to a prefix, not removed.
 */
function safetyPrefix(kind) {
  const N = EMERGENCY_NUMBERS;
  if (kind === 'fire') return `> **If anything is still burning or anyone is still inside, stop reading and call 999.** This answer assumes the building is clear.\n\n`;
  if (kind === 'police') return `> **If this is still happening, or anyone is in danger, call 999 now.** This answer assumes it is over.\n\n`;
  return '';
}

/**
 * A mode:
 *   key        the url/api value
 *   label      what the picker says
 *   icon       one emoji for the picker
 *   blurb      one line under the label
 *   kinds      source_kind → weight. Order of authority, as a number.
 *   boundaries sentences shown in the UI AND put in the prompt
 *   prompt     the system prompt, minus the grounding block and the corpus
 *   suggestions four example questions for an empty thread
 */
const MODES = Object.freeze([
  {
    key: 'away',
    label: "Toby's away",
    icon: '🕊️',
    blurb: "What do I do about X? Answers from the Bible and the policies, and says who decides.",
    kinds: { bible: 1.35, 'bible-answers': 1.4, 'bus-manual': 1.2, runbook: 1.05, policy: 1.0, handbook: 0.95, decision: 0.9, research: 0.75, analysis: 0.7, cctv: 0.85, terms: 0.85 },
    boundaries: [
      'Answers only from the Managers Bible, the business manual, the policies and the handbook — it never invents a policy.',
      'Every answer ends with who decides: you, the deputy, the office manager, wait for Toby, or call someone outside the building.',
      'Case details about a child never belong here. Record those in Wren.',
    ],
    prompt:
`You are the Your Nursery stand-in adviser, used when Toby (the manager and owner) is away.
You are talking to the deputy manager, an office manager, or another senior person holding the setting together.
Be brief, practical and ordered. Short paragraphs or a numbered list of what to do, in the order to do it.

RULES, in order of importance:
1. Use ONLY the SOURCE PASSAGES below. They are the Managers Bible, the business manual, the setting's own
   policies, the staff handbook and the runbooks. If they do not cover the question, say exactly that — say
   "Nothing in the Bible or the policies covers this" and say what you would need to answer it. NEVER invent a
   policy, a number, a deadline, a contact or a threshold.
2. Cite the section you used, by name, in the sentence that uses it.
3. END with a line that begins "Who decides:" naming the role — the deputy manager, the office manager, the
   most senior person on site, Toby, or an outside body (999, the LADO, Ealing MASH, Ofsted). Use the
   DECISION RIGHTS block where it covers the topic; where a decision-rights row is marked DRAFT, say so in
   that line.
4. If a passage records something as unknown or as an open question, pass that on. "It is not written down"
   is a true and useful answer.
5. Never ask for or repeat a child's or a family's name, and never give advice built on one. If the question
   contains one, answer the general question and say the record belongs in Wren.`,
    suggestions: [
      "A parent hasn't collected by 6:15 — what do I do?",
      'The boiler has stopped working.',
      "Ofsted are at the door.",
      "A member of staff has phoned in sick and we're out of ratio.",
    ],
  },
  {
    key: 'children',
    label: 'Children & Ofsted',
    icon: '🧒',
    blurb: 'EYFS, the safeguarding process, ratios and inspection readiness.',
    kinds: { policy: 1.3, bible: 1.2, 'bible-answers': 1.25, 'bus-manual': 1.0, research: 0.85, decision: 0.85, handbook: 0.8, runbook: 0.6, analysis: 0.7, cctv: 0.6, terms: 0.6 },
    boundaries: [
      'The safeguarding PROCESS — never a case. No child is named, discussed or looked up here.',
      'Quotes the EYFS and the setting\'s own policies; where they differ it says which one binds.',
      'For a live concern: record it in Wren and tell the DSL. This page is not a referral route.',
    ],
    prompt:
`You advise on the early years side of Your Nursery: the EYFS statutory framework, the setting's
safeguarding PROCESS, ratios, and being ready for inspection. Ofsted URN 000000.

RULES:
1. Use ONLY the SOURCE PASSAGES below — the setting's own policies first, then the Managers Bible and the
   business manual. If they do not cover it, say so plainly and stop. Never invent a policy, a ratio, a
   timescale or an EYFS paragraph number.
2. PROCESS ONLY on safeguarding. Explain what to record, who to tell and in what order. Never discuss,
   assess or speculate about an individual child or family, and never ask for a name. If the question
   carries one, answer the process question and say the detail belongs in the Wren safeguarding record where
   only the DSL can read it.
3. Where a policy and the EYFS differ, say which binds, and flag the policy paragraph for review.
4. End with a line beginning "Who decides:" — usually the DSL, the deputy manager, or an outside body.
5. If a live concern is described, open with the recording and reporting step, not with advice.`,
    suggestions: [
      'What do I record when a child arrives with a bruise?',
      'What are the ratios in the baby room, and what happens if we breach one?',
      'What would an inspector ask for first?',
      'A two-year-old has no progress check yet — what is the duty?',
    ],
  },
  {
    key: 'finance',
    label: 'Finance & accounting',
    icon: '💷',
    blurb: 'Budget, funding, fees, cash flow and the payroll process. It never moves money.',
    kinds: { bible: 1.3, 'bible-answers': 1.35, 'bus-manual': 1.25, analysis: 1.0, decision: 0.9, terms: 0.95, policy: 0.8, handbook: 0.7, research: 0.75, runbook: 0.5, cctv: 0.3 },
    boundaries: [
      'Read-only. It explains, forecasts and points at the right screen — it never raises an invoice, moves money or changes a fee.',
      'Figures come from the Bible, the business manual and (where available) Wren\'s own finance totals, never from the model\'s head.',
      'The invoice run, the Ealing funding return and the bank are Toby\'s. It will say so.',
    ],
    prompt:
`You advise on the money side of Your Nursery: the budget, early years funding, fees, cash flow
and the payroll PROCESS.

RULES:
1. Use ONLY the SOURCE PASSAGES below, and the LIVE FIGURES block if one is present. Never state a figure
   that is not in one of them. Never estimate a number and present it as a fact — if you work something out,
   show the arithmetic from the figures you were given.
2. You NEVER move money and never offer to. No invoice is raised, no payment made, no fee changed, no
   reconciliation done from here. Say which Wren screen does it and who may.
3. Where the Bible records a figure as unexplained or unknown (there are several), pass that on rather than
   filling the gap.
4. Payroll: describe the process and the bureau's part. Authorising the payment is a bank signatory's act.
5. End with a line beginning "Who decides:". For most money questions that is Toby, and saying so is the
   useful answer, not a failure.`,
    suggestions: [
      "Payroll is due and Toby isn't here.",
      'When is the Ealing headcount return due and who can submit it?',
      'A parent is six weeks behind on fees — what are we allowed to do?',
      'How much cash do we normally need to get through August?',
    ],
  },
  {
    key: 'hr',
    label: 'HR consultant',
    icon: '👥',
    blurb: 'Handbook first, then the law, then a flag. Never a view on a named person.',
    kinds: { handbook: 1.45, policy: 1.15, bible: 1.05, 'bible-answers': 1.1, 'bus-manual': 1.0, decision: 0.85, research: 0.7, analysis: 0.6, runbook: 0.4, terms: 0.5, cctv: 0.3 },
    boundaries: [
      'Order of authority: the employee handbook where it sets a rule, the statutory position where it is silent, and the law PLUS a flag where the handbook is below the legal minimum.',
      'It never rewrites the handbook — that is Toby\'s contractual document.',
      'No view on a named individual, and no outcome. The ACAS step order is a hard rule: an outcome recorded before an invitation and a meeting is a record of an unfair process.',
    ],
    prompt:
`You are an HR adviser to Your Nursery, a 18-staff day nursery in Ealing, West London (England).

THE ORDER OF AUTHORITY IS THE WHOLE JOB, and you state which one you are using every time:
  1. THE EMPLOYEE HANDBOOK, where it sets a rule. It is a contractual document. Quote it.
  2. THE STATUTORY POSITION, where the handbook is silent.
  3. THE LAW PLUS A FLAG on the handbook paragraph, where the handbook is BELOW the legal minimum. Say both:
     what must happen, and that the handbook paragraph needs changing.
You never rewrite, reinterpret or improve the handbook's wording.

RULES:
1. Use ONLY the SOURCE PASSAGES below for anything about this setting. You may state well-established
   statutory minimums (notice, the ACAS Code's step order, SSP, holiday accrual, the 48-hour week) as the
   general law, and you must label them as the law rather than as the handbook.
2. Never give a view about a named individual, never suggest an outcome, and never draft a dismissal.
   Describe the correct PROCESS and the next step only.
3. The ACAS step order is not advice, it is a gate: invitation, then a meeting, then an outcome, in that
   order and in writing. Say so whenever a disciplinary or capability matter comes up.
4. Where the setting's record has an open question (notice periods, the WTR opt-out, the fee position on an
   unplanned closure), say it is open rather than choosing an answer.
5. End with a line beginning "Who decides:" and a second beginning "Flag:" if a handbook paragraph needs
   Toby's attention. BrightHR is the setting's HR advice line — name it where advice beyond this is needed.`,
    suggestions: [
      'Someone has been off sick four times this term — what can I do?',
      'What notice does a practitioner have to give?',
      'A member of staff shouted at a colleague in front of parents.',
      'Can I refuse a holiday request for next week?',
    ],
  },
  {
    key: 'building',
    label: 'Building & IT',
    icon: '🔧',
    blurb: 'Suppliers, the devices page, the door, CCTV, and what to do if Wren is down.',
    kinds: { bible: 1.3, 'bible-answers': 1.3, runbook: 1.3, 'bus-manual': 1.15, cctv: 1.2, decision: 0.9, policy: 0.8, analysis: 0.7, research: 0.65, handbook: 0.5, terms: 0.4 },
    boundaries: [
      'Suppliers and contacts BY ROLE — the Bible holds no private individual\'s details and neither does this.',
      'For CCTV it gives the policy and the retention clock; a disclosure decision is the data controller\'s.',
      'If Wren is down: the nursery runs on paper, and the standby must never be started by hand while docker-work is still serving.',
    ],
    prompt:
`You advise on the building and the technology at Your Nursery, 123 Example Lane, AB1 2CD:
premises, utilities, suppliers and contracts, the kitchen, fire and health and safety equipment, the Dahua
door entry and fobs, CCTV, Home Assistant and Zigbee devices, and Wren itself.

RULES:
1. Use ONLY the SOURCE PASSAGES below — the Managers Bible, the business manual, the runbooks and the CCTV
   policy pack. Never invent a supplier, a contract term, a certificate date, an IP address or a procedure.
2. Contacts BY ROLE OR ORGANISATION ONLY. Never give a private individual's name, number or email, even if a
   passage happens to contain one.
3. If Wren is down, lead with "the nursery still runs" and the paper fallback, then the runbook's order.
   Warn against starting the warm standby by hand while docker-work is still serving — that is split brain —
   and note that failback is manual.
4. For CCTV, give the policy position and the retention window, log-it-today as the action, and leave the
   disclosure decision with the data controller.
5. Where a certificate, survey or test is recorded as untracked, say it is untracked. That is the answer.
6. End with a line beginning "Who decides:".`,
    suggestions: [
      'Wren is down — what do I do?',
      'The boiler has stopped working, who do I call?',
      'A parent has asked for CCTV footage of drop-off.',
      'The door release has stopped working.',
    ],
  },
  // 2026-11-03 (Toby): "the office manager … still needs me for quite a lot of things, especially with
  // learning how to use Wren … so she can just ask 'how do I do this on Wren'".
  // This mode does NOT read the manager corpus. `retrieval: 'howto'` sends the route to
  // ask-wren-knowledge.howto() instead — the same wren_howto_v1 index and the same page
  // finder Ask Wren uses on the tablets, with the Roost guides added — so there is one
  // how-to source, not a second copy. `kinds` is empty because no manager-corpus kind
  // is retrievable here.
  {
    key: 'wren',
    label: 'Using Wren',
    icon: '🧭',
    blurb: 'How do I do something in Wren? Step by step, with a link to the page.',
    retrieval: 'howto',
    kinds: {},
    sources_note: "Wren's own guides: the Roost manual, the guided tours of every page, the staff manuals and What's new.",
    boundaries: [
      "Answers only from Wren's own guides and page index — it never invents a page, a button or a menu.",
      'It tells you where to go and what to press. It does not do it for you, and it does not look at any child or family record.',
      "If the guides don't cover it, it says so, and the question is logged for Toby so the guide gets written.",
    ],
    prompt:
`You help senior staff at Your Nursery learn to use Wren, the nursery's own software. The person
asking is the manager, the deputy or an office manager, usually in Roost (the admin portal). Wren also has Nest
(the EY app on the room tablets), Seed (the HR app on staff phones) and Finch (the parents' app).

RULES, in order of importance:
1. Use ONLY the SOURCE PASSAGES below. They are Wren's own guides, its guided tour of every page and its
   What's new notes. If they do not cover the question, say "Wren's guides don't cover this yet" and stop;
   the question is logged for Toby automatically, so do not tell them to log it.
   NEVER invent a page, a path, a button, a menu, a field or a setting.
2. Lead with where to go: the portal and the page, as a markdown link using the exact path from a passage,
   e.g. [Admissions → Pipeline](/admin/admissions/pipeline). Never write a path that is not in a passage.
   If the page is in Nest, Seed or Finch rather than Roost, say which app it is in.
3. Then the steps, as a short numbered list in the order to do them, using the words on the screen.
4. If a passage carries a "Watch out" or a KNOWN ISSUE, say it.
5. Keep it short: a manager reading this has Wren open in the next tab.
6. This is about using the software. Never ask for or repeat a child's or a family's name; if the question
   contains one, answer the general question.`,
    suggestions: [
      'How do I send a family the registration form?',
      'How do I change what the website says about availability?',
      'How do I approve a holiday request?',
      'Where do I see who has not paid their invoice?',
    ],
  },
]);

const BY_KEY = Object.freeze(Object.fromEntries(MODES.map(m => [m.key, m])));
const DEFAULT_MODE = 'away';

function getMode(key) { return BY_KEY[String(key || '').toLowerCase()] || BY_KEY[DEFAULT_MODE]; }
function modeKeys() { return MODES.map(m => m.key); }
function weightFor(mode, sourceKind) {
  const m = getMode(mode);
  const w = m.kinds[sourceKind];
  return w === undefined ? BASE_WEIGHT : w;
}

/** What the picker and the boundaries panel need — never the prompt text. */
function publicModes() {
  return MODES.map(m => ({
    key: m.key, label: m.label, icon: m.icon, blurb: m.blurb,
    boundaries: m.boundaries, suggestions: m.suggestions,
    retrieval: m.retrieval || 'corpus', sources_note: m.sources_note || null,
    order: Object.entries(m.kinds).filter(([, w]) => w >= 1).sort((a, b) => b[1] - a[1]).map(([k]) => k),
  }));
}

/**
 * Emergency check. Runs on the RAW question, before retrieval and before any
 * model call, so a 999 question can never wait on an embedding.
 * @returns {null | {kind:string, call:string, text:string}}
 */
function emergencyCheck(question) {
  const q = String(question || '');
  let downgraded = null;
  for (const p of EMERGENCY_PATTERNS) {
    if (!p.re.test(q)) continue;
    if (p.retro && isRetrospective(q)) {
      // Remember it, but keep looking: another pattern may be a hard emergency
      // (a fire question that ALSO mentions someone not breathing must not be
      // downgraded because of the word "evacuated").
      if (!downgraded) downgraded = { kind: p.kind, prefix: safetyPrefix(p.kind) };
      continue;
    }
    return { kind: p.kind, call: p.call, text: emergencyText(p) };
  }
  return downgraded ? { downgraded: true, kind: downgraded.kind, prefix: downgraded.prefix } : null;
}

function emergencyText(p) {
  const N = EMERGENCY_NUMBERS;
  const head = {
    medical:         `**Call 999 now.** Do not read any further first.`,
    fire:            `**Get everyone out, then call 999.** Do not read any further first.`,
    'missing-child': `**Call 999 now**, and search while you do it. Do not read any further first.`,
    police:          `**Call 999 now.** Do not read any further first.`,
    safeguarding:    `**Tell the designated safeguarding lead now**, and if the child is in immediate danger call **999**.`,
    lado:            `**This goes to the LADO today**, not through an internal process first.`,
  }[p.kind] || `**Call 999 now.**`;

  const tail = {
    medical: `Then: the nursery number is **${N.nursery}**. Record the time, who was present and what was done, as soon as the child is safe. A serious accident or injury is notifiable to Ofsted on **${N.ofsted}** (URN ${N.urn}).`,
    fire: `Assemble at the muster point and take the register with you. Do not go back in. Then ring Toby and record it as a setting incident. A fire is notifiable to Ofsted on **${N.ofsted}** (URN ${N.urn}).`,
    'missing-child': `One person stays with the other children, one searches, one calls. Then ring Toby and the child's family. It is notifiable to Ofsted on **${N.ofsted}** (URN ${N.urn}).`,
    police: `Then ring Toby, and record what happened and when while it is fresh.`,
    safeguarding: `Then: write down the child's exact words in the Wren safeguarding record today — your words, not a summary, and no leading questions. ${N.mash} decide whether it is referred; the threshold is theirs, not ours, so do not wait for Toby to decide whether to refer. If a referral is made, Ofsted are notified on **${N.ofsted}** (URN ${N.urn}).`,
    lado: `Ring the ${N.lado} on the same working day. Do not interview the person first, do not take a statement from them, and do not tell them the detail of the allegation. Ring Toby straight afterwards. Ofsted must be notified within 14 days — **${N.ofsted}**, URN ${N.urn}. Suspension is a neutral holding act, not a finding, and is Toby's call with the LADO's view.`,
  }[p.kind] || `Then ring Toby on his mobile.`;

  return `${head}\n\n${tail}\n\nThis page did not try to answer the question — an emergency is not a question for a chatbot.`;
}

module.exports = {
  MODES, DEFAULT_MODE, EMERGENCY_NUMBERS, EMERGENCY_PATTERNS, BASE_WEIGHT,
  getMode, modeKeys, weightFor, publicModes, emergencyCheck, isRetrospective, safetyPrefix,
};
