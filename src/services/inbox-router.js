'use strict';
/**
 * inbox-router.js — b235 (2026-08-26)
 *
 * The thing Toby actually asked for: "I get overwhelmed with spam emails and
 * tasks and jobs and find it hard to start. I need direction."
 *
 * So this is a classifier and a queue, not another dashboard. It takes one
 * item — a parents-portal thread, a comms-hub thread, an enquiry, a Gmail
 * thread — and returns exactly one verdict:
 *
 *   { lane, urgency, who, deadline, suggested_action, draft_reply, confidence }
 *
 * ── FIVE LANES, AND WHY SO FEW ──────────────────────────────────────────────
 * A router with fifteen buckets is a second inbox. These five are the only
 * decisions that actually change what happens next:
 *
 *   reply-now              under two minutes, do it while you are looking at it
 *   delegate-to-ayla       someone else's job; the only thing needed is sending it
 *   schedule               real work, needs a slot, not now
 *   waiting-on-someone-else  the ball is not in our court; chase date only
 *   no-action              read it or don't; it never needed an answer
 *
 * ── THE LANES ARE DERIVED FROM TOBY'S OWN LABELS, NOT INVENTED ──────────────
 * The mailbox already carries years of hand-filing: `1. TO DO`,
 * `2. the admissions lead to respond`, `Parents/Current`, `Admin / Bills`, `Government/HMRC
 * Audit`, `Misc/Newsletters` and the rest. That is a labelled training set
 * produced by the only person whose judgement matters here, and LANE_FROM_LABEL
 * below maps it onto the five lanes rather than replacing it.
 *
 * Two consequences worth stating:
 *   • `2. the admissions lead to respond` is proof that delegation already happens. If items
 *     filed there historically went unanswered, the delegate-to-ayla lane will
 *     leak the same way, and the analysis measures exactly that.
 *   • The label set is also the eval set. `agreementRate()` scores the router
 *     against Toby's filing on held-out threads. A low score is a finding.
 *
 * ── THE BYPASS ──────────────────────────────────────────────────────────────
 * Safeguarding, medical, allergy and complaint content never reaches the model.
 * forceLane() runs FIRST, and if it fires, that is the answer — the model is not
 * asked, so it cannot disagree, and no confidence score can downgrade it. A
 * language model that decided an allergy email was "no-action" would be the
 * single worst failure this build could produce, so the design removes the
 * opportunity rather than managing it.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 * Local only, via src/lib/sovereign-model.js, which refuses any non-private
 * host. Invalid JSON is retried once and then falls back to ruleVerdict() — a
 * deterministic classifier that is always available. The router therefore has
 * no failure mode where an item goes unclassified.
 *
 * Draft replies are DRAFTS. Nothing in b235 sends anything.
 */

const sovereign = require('../lib/sovereign-model');
const { safe } = require('../lib/inbox-redact');

const LANES = ['reply-now', 'delegate-to-ayla', 'schedule', 'waiting-on-someone-else', 'no-action'];
const URGENCIES = ['red', 'amber', 'green'];

// ── the bypass ──────────────────────────────────────────────────────────────
// Word-boundary matched, deliberately broad. A false positive costs Toby a
// glance at something that turned out to be routine. A false negative costs a
// missed disclosure. The asymmetry is the whole point, so this list errs long.
const FORCE_PATTERNS = [
  // NOTE on "disclosure". It used to appear here as a bare `disclos(?:ed|ure)`,
  // and it was the single most common trigger in the mailbox — because DBS
  // stands for *Disclosure* and Barring Service. Every routine vetting
  // notification, and every UCheck invoice for DBS checks, was being force-routed
  // to RED as a child-protection matter. Measured over 400 real threads: 3 of the
  // 8 force-routes were DBS paperwork.
  //
  // That is not a harmless over-trigger. A red lane that fills up with vetting
  // admin is a red lane Toby learns to skim, and then the one real disclosure
  // goes past with the rest of them. So the phrase now has to look like an
  // actual disclosure, and barring DECISIONS (a genuine safety signal) are
  // matched separately.
  { key: 'safeguarding', re: /\b(safeguard\w*|child protection|social (?:worker|services)|section 47|welfare concern|early help|bruis\w+|unexplained (?:mark|injury)|neglect|abuse|allegation against|made a disclosure|disclosed (?:to|that|something)|disclosure (?:about|from|regarding|concerning)|barred list|barring decision|unsuitable to work with children)\b/i },
  // Acronyms, CASE-SENSITIVE and deliberately separate. Under /i, `\bCAF\b`
  // matches "caf", `\bCIN\b` matches "cin", and `\bMASH\b` matches a recipe.
  // These only mean what they mean in capitals.
  { key: 'safeguarding', re: /\b(LADO|MASH|CAF|CIN meeting|CP plan|DSL|s47)\b/ },
  { key: 'medical',      re: /\b(medic(?:ine|ation|al)|prescri\w+|epi[-\s]?pen|anaphyla\w+|seizure|epilep\w+|asthma|inhaler|ambulance|A&?E|hospital|999|first aid|head injury|choking|unconscious|temperature of|febrile)\b/i },
  { key: 'allergy',      re: /\b(allerg\w+|allergen|intoleran\w+|anaphyla\w+|nut[-\s]?free|dairy[-\s]?free|coeliac|celiac|dietary requirement)\b/i },
  // NOTE the \w* on complain: `complain\w+` demands a suffix, so it matched
  // "complaint" and "complaining" but NOT a bare "complain" — and "I do not want
  // to complain as such, but..." is precisely how a real complaint opens.
  // Caught by the bypass test, 2026-08-26.
  { key: 'complaint',    re: /\b(complain\w*|formal complaint|escalat\w+|ombudsman|solicitor|legal action|negligen\w+|unacceptable|unhappy (?:with|about)|disgust\w+|rais\w+ (?:this|it) (?:formally|with)|report(?:ing)? (?:you|this) to|Ofsted (?:complaint|concern|referral))\b/i },
];

const FORCE_REASON = {
  safeguarding: 'Safeguarding language — routed by rule, not by the model, and never downgraded.',
  medical:      'Medical or medication content — routed by rule, not by the model, and never downgraded.',
  allergy:      'Allergy or dietary-safety content — routed by rule, not by the model, and never downgraded.',
  complaint:    'Reads as a complaint — routed by rule so it cannot be triaged away.',
};

/**
 * Does this item bypass the model? Runs before any classification.
 * @param {{subject?:string, body?:string, snippet?:string}} item
 * @returns {{lane:string, urgency:string, reason:string, key:string}|null}
 */
function forceLane(item) {
  const hay = [item.subject, item.snippet, item.body, item.category, item.topic]
    .filter(Boolean).join('\n');
  if (!hay) return null;
  for (const p of FORCE_PATTERNS) {
    if (p.re.test(hay)) {
      return { lane: 'reply-now', urgency: 'red', key: p.key, reason: FORCE_REASON[p.key] };
    }
  }
  return null;
}

// ── Toby's labels → lanes ───────────────────────────────────────────────────
// Longest prefix wins, so `1. TO DO/DBS` is matched before `1. TO DO`.
const LANE_FROM_LABEL = [
  // He filed these as "I must do this". They are work, and work gets a slot.
  ['1. TO DO/Post holiday/UCheck', 'schedule'],
  ['1. TO DO/Post holiday',        'schedule'],
  ['1. TO DO/DBS',                 'schedule'],
  ['1. TO DO',                     'schedule'],
  // Already delegated by hand — this is the lane's ground truth.
  ['2. the admissions lead to respond',          'delegate-to-ayla'],
  // Parents expect an answer from a person.
  ['Parents/Current',              'reply-now'],
  ['Parents/Prospective',          'reply-now'],
  ['Parents/Confirmed Baby 27',    'schedule'],
  ['Parents/Confirmed PS 26',      'schedule'],
  ['Parents',                      'reply-now'],
  // Staff: notifications are FYI, statements and new starters are not.
  ['Staff/HR Notifications',       'no-action'],
  ['Staff/Incident statements',    'reply-now'],
  ['Staff/New staff/Work Ex',      'schedule'],
  ['Staff/Sent to Staff@',         'no-action'],
  ['Staff',                        'schedule'],
  // Money in and money out. Bills are scheduled work; debts are chases.
  ['Admin / Bills/INSURANCE',      'schedule'],
  ['Admin / Bills/Purchases',      'schedule'],
  ['Admin / Bills/Systems',        'schedule'],
  ['Admin / Bills',                'schedule'],
  ['Financial / Banking/DEBTS',    'waiting-on-someone-else'],
  ['Financial / Banking',          'schedule'],
  // Statutory correspondence carries dates.
  ['Government/HMRC Audit',        'schedule'],
  ['Government/Ealing Borough',    'schedule'],
  ['Government',                   'schedule'],
  // Noise, by his own filing.
  ['Misc/Newsletters',             'no-action'],
  ['Misc/Splash & Dash',           'no-action'],
  ['Misc',                         'no-action'],
];

/** The lane implied by Toby's own filing, or null if he never filed it. */
function laneFromLabels(labels) {
  if (!Array.isArray(labels) || !labels.length) return null;
  let best = null, bestLen = -1;
  for (const [prefix, lane] of LANE_FROM_LABEL) {
    for (const l of labels) {
      if (l === prefix && prefix.length > bestLen) { best = lane; bestLen = prefix.length; }
    }
  }
  return best;
}

/** The label that decided it — used for reporting, never for display of content. */
function decidingLabel(labels) {
  if (!Array.isArray(labels)) return null;
  let best = null, bestLen = -1;
  for (const [prefix] of LANE_FROM_LABEL) {
    for (const l of labels) if (l === prefix && prefix.length > bestLen) { best = prefix; bestLen = prefix.length; }
  }
  return best;
}

// ── the deterministic classifier ────────────────────────────────────────────
// This is the fallback when the model is unavailable or unparseable, and it is
// also what makes the router honest: there is always an answer, and it is one
// anybody can read off the rules.
const BULK_RE = /\b(unsubscribe|newsletter|no[-\s]?reply|noreply|do not reply|webinar|marketing|promotion|special offer|view (?:this )?in browser)\b/i;
const AWAIT_RE = /\b(we will|will be in touch|awaiting|pending|has been (?:raised|logged|received)|your (?:ticket|case|reference)|under review|we have received|processing your)\b/i;
const DEADLINE_RE = /\b(deadline|due (?:by|on)|expires?|by (?:the )?\d{1,2}(?:st|nd|rd|th)?\s+\w+|closing date|final notice|last chance to|must be (?:submitted|returned) by)\b/i;
const QUICK_RE = /\b(quick question|can you confirm|just checking|is it ok|what time|are you open|do you have (?:any )?(?:spaces?|availability)|could you let me know)\b/i;

/**
 * A verdict from rules alone. Never throws, never returns null.
 * @param {object} item
 * @returns {object} verdict
 */
function ruleVerdict(item) {
  const forced = forceLane(item);
  if (forced) {
    return verdict({
      lane: forced.lane, urgency: forced.urgency, who: 'toby',
      deadline: null,
      suggested_action: 'Read it now and respond today. This was routed by rule, not by judgement.',
      draft_reply: null, confidence: 1,
      source: 'rule-forced', forced: true, forced_reason: forced.reason, forced_key: forced.key,
    });
  }

  const hay = [item.subject, item.snippet, item.body].filter(Boolean).join('\n');
  const labelLane = laneFromLabels(item.labels);
  const ageDays = item.age_days == null ? null : Number(item.age_days);

  // Toby's own filing outranks any keyword guess.
  if (labelLane) {
    return verdict({
      lane: labelLane,
      urgency: labelLane === 'reply-now' ? (ageDays != null && ageDays > 3 ? 'red' : 'amber')
             : labelLane === 'no-action' ? 'green' : 'amber',
      who: labelLane === 'delegate-to-ayla' ? 'ayla' : 'toby',
      deadline: null,
      suggested_action: `Filed under "${decidingLabel(item.labels)}" — treated as ${labelLane}.`,
      draft_reply: null,
      confidence: 0.8,
      source: 'rule-label',
    });
  }

  if (item.list_id || BULK_RE.test(hay)) {
    return verdict({ lane: 'no-action', urgency: 'green', who: 'nobody', deadline: null,
      suggested_action: 'Bulk or marketing mail — filter it rather than reading it.',
      draft_reply: null, confidence: 0.7, source: 'rule-bulk' });
  }
  if (item.last_direction === 'out' || item.answered) {
    return verdict({ lane: 'waiting-on-someone-else', urgency: 'green', who: 'them', deadline: null,
      suggested_action: 'You answered last — nothing to do until they come back.',
      draft_reply: null, confidence: 0.75, source: 'rule-answered' });
  }
  if (AWAIT_RE.test(hay)) {
    return verdict({ lane: 'waiting-on-someone-else', urgency: 'green', who: 'them', deadline: null,
      suggested_action: 'They said they would come back to you. Set a chase date and drop it.',
      draft_reply: null, confidence: 0.6, source: 'rule-awaiting' });
  }
  if (item.kind === 'enquiry' && !item.answered) {
    return verdict({ lane: 'reply-now', urgency: ageDays != null && ageDays > 2 ? 'red' : 'amber',
      who: 'toby', deadline: null,
      suggested_action: 'An unanswered enquiry is a lost place. Reply or hand it to the deputy today.',
      draft_reply: null, confidence: 0.85, source: 'rule-enquiry' });
  }
  if (QUICK_RE.test(hay)) {
    return verdict({ lane: 'reply-now', urgency: 'amber', who: 'toby', deadline: null,
      suggested_action: 'Short factual question — answer it in one line now.',
      draft_reply: null, confidence: 0.65, source: 'rule-quick' });
  }
  if (DEADLINE_RE.test(hay)) {
    return verdict({ lane: 'schedule', urgency: 'amber', who: 'toby', deadline: null,
      suggested_action: 'Carries a date. Put it in the diary rather than the inbox.',
      draft_reply: null, confidence: 0.6, source: 'rule-deadline' });
  }
  if (item.last_direction === 'in' && ageDays != null && ageDays > 7) {
    return verdict({ lane: 'schedule', urgency: 'amber', who: 'toby', deadline: null,
      suggested_action: 'Inbound and more than a week old — decide now whether it is ever getting done.',
      draft_reply: null, confidence: 0.5, source: 'rule-stale' });
  }
  return verdict({ lane: 'schedule', urgency: 'amber', who: 'toby', deadline: null,
    suggested_action: 'No rule matched confidently — look at it once and decide.',
    draft_reply: null, confidence: 0.3, source: 'rule-default' });
}

// ── the model path ──────────────────────────────────────────────────────────

// The lane descriptions below are written FROM Toby's own label taxonomy —
// `1. TO DO`, `Admin / Bills`, `Government/HMRC Audit`, `Misc/Newsletters` and
// the rest — because the brief's instruction was to derive the lanes from his
// filing rather than invent a parallel scheme. The model is told what KIND of
// thing belongs in each lane. It is never told which label the item in front of
// it carries; agreementRate() would be meaningless if it were.
//
// The "most mail is not a newsletter" line is there for a measured reason: the
// first eval run came back with the model putting 11 of 14 labelled threads in
// no-action, well below chance. Some of that was a genuine bug (see the sweep's
// is_bulk note) and some of it was the model's own prior.
const SYSTEM = `You triage the inbox of the manager of a small English day nursery.
He is overwhelmed and needs direction, not analysis. Assign exactly one lane.

LANES, and the kinds of thing that belong in each
- "reply-now": a parent (current or prospective) asking something; an enquiry about
  a place; anything about a child's safety, health or food; a short factual question
  he can answer in one line.
- "delegate-to-ayla": routine admin, supplier scheduling, or a question the deputy
  manager can answer without him. He only needs to forward it.
- "schedule": real work that needs a slot in the diary — bills and invoices to pay,
  insurance and subscription renewals, purchases, council and HMRC correspondence,
  DBS and staff vetting paperwork, recruitment, anything with a form to complete.
- "waiting-on-someone-else": he has already acted and is waiting on a reply, a
  delivery, a refund, a decision or a debt to be paid.
- "no-action": marketing, newsletters, automated notifications, receipts filed for
  the record, and anything that closed itself.

Most mail in this inbox is NOT a newsletter. Only choose "no-action" when the
message genuinely asks nothing of the setting. A bill, a government letter or a
form to complete is "schedule", not "no-action" — it is work he has not done yet.

RULES
- urgency is "red", "amber" or "green".
- who is "toby", "ayla", "them" or "nobody".
- deadline is an ISO date (YYYY-MM-DD) only if the text states or clearly implies one, else null.
- suggested_action is ONE imperative sentence, under 20 words, telling him what to do.
- draft_reply is a short reply he could send, or null when no reply is needed. It is a DRAFT and will never be sent automatically.
- confidence is 0 to 1.
- Never invent facts. If you do not know, say so in suggested_action and lower confidence.

Reply with a single JSON object and nothing else.`;

function buildPrompt(item) {
  const lines = [];
  lines.push(`Item type: ${item.kind || 'email'}`);
  if (item.age_days != null) lines.push(`Age: ${Math.round(item.age_days)} days since the last message`);
  if (item.last_direction) lines.push(`Last message direction: ${item.last_direction === 'in' ? 'from them (unanswered)' : 'from us'}`);
  if (item.msg_count != null) lines.push(`Messages in thread: ${item.msg_count}`);
  if (item.from_domain) lines.push(`Sender domain: ${item.from_domain}`);
  if (item.list_id) lines.push('This is bulk/list mail.');
  if (item.subject) lines.push(`Subject: ${item.subject}`);
  if (item.snippet) lines.push(`Opening text: ${item.snippet}`);
  if (item.body) lines.push(`Body:\n${String(item.body).slice(0, 4000)}`);
  lines.push('', 'JSON keys: lane, urgency, who, deadline, suggested_action, draft_reply, confidence');
  return lines.join('\n');
}

/** Coerce anything the model returned into a verdict we are willing to store. */
function verdict(v = {}) {
  const lane = LANES.includes(v.lane) ? v.lane : 'schedule';
  let urgency = URGENCIES.includes(v.urgency) ? v.urgency : null;
  if (!urgency) urgency = lane === 'reply-now' ? 'red' : lane === 'no-action' ? 'green' : 'amber';
  let conf = Number(v.confidence);
  if (!isFinite(conf)) conf = 0.4;
  conf = Math.max(0, Math.min(1, conf));
  let deadline = null;
  if (v.deadline && /^\d{4}-\d{2}-\d{2}$/.test(String(v.deadline))) deadline = String(v.deadline);
  const who = ['toby', 'ayla', 'them', 'nobody'].includes(v.who) ? v.who
            : lane === 'delegate-to-ayla' ? 'ayla'
            : lane === 'waiting-on-someone-else' ? 'them'
            : lane === 'no-action' ? 'nobody' : 'toby';
  return {
    lane, urgency, who, deadline,
    suggested_action: trim(v.suggested_action, 220) || 'Look at it once and decide.',
    draft_reply: v.draft_reply ? trim(v.draft_reply, 1500) : null,
    confidence: conf,
    source: v.source || 'model',
    forced: v.forced === true,
    forced_reason: v.forced_reason || null,
    forced_key: v.forced_key || null,
  };
}

function trim(s, max) {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * Classify one item. The bypass runs first; the model only ever sees what the
 * bypass did not claim.
 *
 * @param {object} item
 * @param {string} item.kind        'gmail_thread'|'portal_thread'|'comms_thread'|'enquiry'
 * @param {string} item.ref         stable id within that kind
 * @param {string} [item.subject]
 * @param {string} [item.snippet]
 * @param {string} [item.body]
 * @param {string[]} [item.labels]
 * @param {string} [item.last_direction] 'in'|'out'
 * @param {number} [item.age_days]
 * @param {boolean} [item.answered]
 * @param {object} [opts]
 * @param {boolean} [opts.useModel=true]
 * @returns {Promise<object>} verdict, always
 */
async function classify(item, opts = {}) {
  // 1. The bypass. Before anything else, and not overridable.
  const forced = forceLane(item);
  if (forced) {
    const v = ruleVerdict(item);
    v.model = null;
    return v;
  }

  if (opts.useModel === false) {
    const v = ruleVerdict(item);
    v.model = null;
    return v;
  }

  // 2. The local model. Two attempts inside generateJSON, then rules.
  try {
    const r = await sovereign.generateJSON({
      system: SYSTEM,
      prompt: buildPrompt(item),
      model: opts.model,
      temperature: 0,
      numPredict: 450,
    });
    if (r.ok) {
      const v = verdict(Object.assign({}, r.value, { source: 'model' }));
      v.model = opts.model || sovereign.MODEL;
      // A model verdict of very low confidence is worth less than a rule that
      // matched cleanly, so the rules get the last word in that one case.
      if (v.confidence < 0.25) {
        const rv = ruleVerdict(item);
        if (rv.confidence > v.confidence) { rv.model = v.model; rv.source = 'rule-lowconf'; return rv; }
      }
      return v;
    }
    const v = ruleVerdict(item);
    v.model = null;
    v.source = 'rule-badjson';
    return v;
  } catch (e) {
    // A REFUSED/unreachable host must surface, not be silently downgraded —
    // otherwise "the sovereign model was down for a week" looks like a clean run.
    if (/REFUSED/.test(e.message)) throw e;
    const v = ruleVerdict(item);
    v.model = null;
    v.source = 'rule-modeldown';
    v.note = safe(e.message, { max: 120 });
    return v;
  }
}

/**
 * Score the router against Toby's own filing.
 * @param {Array<{predicted:string, labels:string[]}>} rows
 */
function agreementRate(rows) {
  const byLane = {};
  let n = 0, agree = 0;
  for (const r of rows) {
    const truth = laneFromLabels(r.labels);
    if (!truth) continue;
    n++;
    byLane[truth] = byLane[truth] || { n: 0, agree: 0, confused_with: {} };
    byLane[truth].n++;
    if (r.predicted === truth) { agree++; byLane[truth].agree++; }
    else byLane[truth].confused_with[r.predicted] = (byLane[truth].confused_with[r.predicted] || 0) + 1;
  }
  return {
    scored: n,
    agreed: agree,
    rate: n ? +(agree / n).toFixed(4) : null,
    per_lane: byLane,
  };
}

module.exports = {
  LANES, URGENCIES, FORCE_PATTERNS, LANE_FROM_LABEL,
  classify, ruleVerdict, forceLane, laneFromLabels, decidingLabel,
  agreementRate, verdict, buildPrompt,
};
