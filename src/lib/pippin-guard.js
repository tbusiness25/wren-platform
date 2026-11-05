'use strict';
/**
 * pippin-guard.js — b518 (2026-10-20)
 *
 * THE CONTROL for everything Wren sends to Toby's home Pippin through the work→home
 * bridge. The bridge's own filter (see /app/ladn-ready/logs/pippin-bridge.NOTES.md)
 * is a safety net, not the control, and it says so itself: it CANNOT detect a plain
 * first name. This file can, because it reads the live tables.
 *
 * What it does, in order:
 *   1. CLEANS free text — strips dates, emails, phone-like runs, postcodes and NI
 *      numbers out of note/body text (the bridge 422s on any of them, and none of
 *      them belongs at home anyway). Dates belong in `start` / `end` / `due`.
 *   2. REFUSES, with a reason the sender can act on:
 *        • any child, parent/carer, emergency-contact or staff name — full name OR
 *          plain first name OR surname, matched against children / contacts / staff
 *          in memory (nothing leaves the machine to do this check);
 *        • a family email address;
 *        • safeguarding, medical/allergy, SEN/EHCP or HR content, however phrased;
 *        • anything still holding a date, address or number after cleaning.
 *   3. Returns the EXACT text that would be sent, so the sender confirms a preview
 *      rather than trusting us (src/routes/pippin.js shows it).
 *
 * Staff who are also parents are handled as in b352: the name is still refused —
 * no name crosses, ever — but it is reported as a staff name rather than a
 * family one, so the message the sender reads is the true reason.
 *
 * Calendar events land on Toby's SHARED household calendar, which others at home
 * can see. That is why "generic or nothing" is the rule for titles, not a
 * preference: `genericTitleHint()` is what the UI shows about it.
 */

// Sensitive content: never sent, even anonymised, even as a count.
const SENSITIVE = [
  [/safeguard|child protection|allegation|disclos|lado|cp\s?plan|cin\b|section 47|whistleblow/i, 'safeguarding'],
  [/medic(al|ine|ation)|allerg|epipen|epi-pen|asthma|inhaler|anaphyla|prescri|dose|dosage|injur|bruis|accident|incident|first aid|diagnos|sick|illness|nurse|gp\b|hospital|a&e/i, 'medical'],
  [/\bsen\b|\bsend\b|ehcp|\bihp\b|speech and language|salt referral|portage|early help|tac\b|senco/i, 'sen'],
  [/disciplin|grievance|capability|probation|supervision|appraisal|absence|sickness|pay(roll|slip)?\b|wage|salary|tribunal|warning letter|final written|dismiss|redundan/i, 'hr'],
];

// Things the bridge refuses in free text — stripped here first.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;
const NI_RE = /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;
const MONTHS = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const DATE_RES = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTHS}\\b(\\s+\\d{4})?`, 'gi'),
  new RegExp(`\\b${MONTHS}\\s+\\d{1,2}(st|nd|rd|th)?\\b(\\s+\\d{4})?`, 'gi'),
  /\b20\d{2}\b/g,                       // a bare year reads as a date to the bridge
];
const STREET_RE = /\b\d+[a-z]?\s+[A-Z][a-z]+\s+(Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Close|Gardens|Grove|Way|Drive|Dr|Crescent|Court|Place|Terrace)\b/i;
const TITLE_NAME_RE = /\b(Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+[A-Z][a-z]+/;

// Words that are first names AND ordinary nursery vocabulary. Without this a month
// name or a room theme would refuse half of what Toby wants to send. Deliberately
// short: a false refusal is a reworded sentence, a false pass is a name at home.
const VOCAB_OK = new Set([
  'may', 'june', 'april', 'august', 'summer', 'autumn', 'spring', 'winter',
  'art', 'rose', 'daisy', 'star', 'sunny', 'joy', 'hope', 'grace', 'faith',
  'baby', 'room', 'pre', 'school', 'nursery', 'angel', 'angels', 'little',
  'wren', 'roost', 'ofsted', 'ealing', 'eylog', 'xero',
  // ROLE WORDS. The guard's own advice is "say the role instead", so a role word
  // must never be read as a name — and it would be, because these appear as a
  // first or last name on real rows and as the whole name on scrubbed ones
  // ("Staff" on wren_dev, which is how the sandbox probe found this: every
  // "Staff meeting" was refused).
  'staff', 'team', 'manager', 'deputy', 'leader', 'practitioner', 'apprentice',
  'cook', 'chef', 'accountant', 'parent', 'carer', 'child', 'children', 'family',
  'visitor', 'supplier', 'inspector', 'dev', 'test', 'demo', 'probe',
]);

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/['-]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * buildGuard(query) — load the name sets into memory. `query` takes a SQL string
 * and resolves to { rows }. Nothing is written and nothing leaves the process.
 */
async function buildGuard(query) {
  const family = new Set();      // full names, 'first last'
  const familyFirst = new Set(); // single tokens
  const staffNames = new Set();
  const staffFirst = new Set();
  const emails = new Set();

  const safe = async (sql) => {
    try { return (await query(sql)).rows; }
    catch (e) { if (e.code === '42P01' || e.code === '42703') return []; throw e; }
  };

  const addFull = (set, ...parts) => {
    const t = tokens(parts.filter(Boolean).join(' '));
    if (t.length >= 2 && t.length <= 4 && t.join('').length >= 6) set.add(t.join(' '));
  };
  const addSingles = (set, ...parts) => {
    for (const p of parts) for (const t of tokens(p)) {
      if (t.length >= 3 && !VOCAB_OK.has(t)) set.add(t);
    }
  };
  const addEmail = (e) => {
    const v = String(e || '').trim().toLowerCase();
    if (v.includes('@')) emails.add(v);
  };

  for (const r of await safe(`SELECT first_name, last_name, preferred_forename, preferred_surname, preferred_name,
                                     parent_1_name, parent_2_name, emergency_contact_1_name, emergency_contact_2_name,
                                     parent_1_email, parent_2_email, primary_contact_email FROM children`)) {
    addFull(family, r.first_name, r.last_name);
    addFull(family, r.preferred_forename, r.preferred_surname);
    addFull(family, r.preferred_name, r.last_name);
    addFull(family, r.parent_1_name); addFull(family, r.parent_2_name);
    addFull(family, r.emergency_contact_1_name); addFull(family, r.emergency_contact_2_name);
    addSingles(familyFirst, r.first_name, r.last_name, r.preferred_forename, r.preferred_surname,
               r.preferred_name, r.parent_1_name, r.parent_2_name,
               r.emergency_contact_1_name, r.emergency_contact_2_name);
    addEmail(r.parent_1_email); addEmail(r.parent_2_email); addEmail(r.primary_contact_email);
  }
  // contacts holds families AND business contacts; only those linked to a child are family.
  for (const r of await safe(`SELECT full_name, primary_email FROM contacts
                               WHERE child_ids IS NOT NULL AND cardinality(child_ids) > 0`)) {
    addFull(family, r.full_name);
    addSingles(familyFirst, r.full_name);
    addEmail(r.primary_email);
  }
  // Staff. Their names are refused too — "Staff meeting 14:00", never who is in it.
  for (const r of await safe(`SELECT first_name, last_name, preferred_name FROM staff`)) {
    addFull(staffNames, r.first_name, r.last_name);
    addFull(staffNames, r.preferred_name, r.last_name);
    addSingles(staffFirst, r.first_name, r.last_name, r.preferred_name);
  }
  // b352: a staff member who is also a parent appears in both. Report them as staff,
  // which is the true reason the sender needs to read. Still refused either way.
  for (const n of staffNames) family.delete(n);
  for (const t of staffFirst) familyFirst.delete(t);
  // The nursery's own addresses are not a family's, whoever is on the contact row.
  for (const e of [...emails]) if (/@(example-nursery\.co\.uk|getwren\.co\.uk)$/.test(e)) emails.delete(e);

  const fullLens = new Set([...family, ...staffNames].map(n => n.split(' ').length));

  /** nameHit(text) → { reason, matched } | null */
  function nameHit(text) {
    const t = String(text || '');
    const found = t.match(EMAIL_RE);
    if (found) for (const e of found) if (emails.has(e.toLowerCase())) return { reason: 'family_email', matched: e };
    const words = tokens(t);
    for (const n of fullLens) {
      for (let i = 0; i + n <= words.length; i++) {
        const phrase = words.slice(i, i + n).join(' ');
        if (family.has(phrase)) return { reason: 'family_name', matched: phrase };
        if (staffNames.has(phrase)) return { reason: 'staff_name', matched: phrase };
      }
    }
    for (const w of words) {
      if (familyFirst.has(w)) return { reason: 'family_name', matched: w };
      if (staffFirst.has(w)) return { reason: 'staff_name', matched: w };
    }
    return null;
  }

  return {
    nameHit,
    size: { family: family.size, familyFirst: familyFirst.size, staff: staffNames.size, staffFirst: staffFirst.size, emails: emails.size },
  };
}

/** Strip what the bridge refuses out of free text. Returns { text, stripped[] }. */
function cleanText(raw) {
  const stripped = [];
  let out = String(raw || '');
  const cut = (re, label) => {
    if (re.test(out)) { stripped.push(label); out = out.replace(re, ' '); }
    if (re.lastIndex) re.lastIndex = 0;
  };
  cut(EMAIL_RE, 'an email address');
  cut(NI_RE, 'an NI number');
  cut(POSTCODE_RE, 'a postcode');
  // Dates BEFORE phone-like runs: "2026-11-03" matches PHONE_RE (digit, then eight
  // of [digit space ().-], then digit), so with phones first the date was removed
  // but reported to the sender as "a phone number". The removal was right, the
  // explanation was not — the sandbox probe caught it.
  for (const re of DATE_RES) cut(re, 'a date');
  cut(PHONE_RE, 'a phone number');
  out = out
    .replace(/\(\s*[–-]?\s*\)/g, ' ')
    .replace(/\s+(on|by|since|from|for|at)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[:,]\s*$/, '')
    .trim();
  return { text: out, stripped: [...new Set(stripped)] };
}

function sensitiveHit(text) {
  const t = String(text || '');
  for (const [re, code] of SENSITIVE) if (re.test(t)) return code;
  return null;
}

const SENSITIVE_MSG = {
  safeguarding: 'safeguarding content never leaves Wren',
  medical: 'medical, allergy, accident or illness content never leaves Wren',
  sen: 'SEN / EHCP content never leaves Wren',
  hr: 'HR content (pay, absence, supervision, discipline) never leaves Wren',
};

function genericTitleHint() {
  return 'Calendar events land on Toby’s shared household calendar at home. Keep it generic — "Staff meeting 14:00", not who it is with or what it is about.';
}

/**
 * prepare(guard, draft) — the whole check in one call.
 *
 * draft: { type, title, note|body, steps[], start, end, due, priority }
 * returns { ok, item, preview, refusals[], stripped[], notes[] }
 *   item is EXACTLY the JSON body that will be POSTed to the bridge (minus `id`,
 *   which the route sets), and preview is what the sender is shown and confirms.
 */
function prepare(guard, draft) {
  const d = draft || {};
  const type = String(d.type || '').trim();
  const refusals = [], stripped = [], notes = [];

  if (!['todo', 'calendar_event', 'plan', 'note'].includes(type)) {
    return { ok: false, refusals: [{ code: 'bad_type', message: 'type must be todo, calendar_event, plan or note' }] };
  }

  // Title: never cleaned silently — a title with a date or a name stripped out of
  // it reads as nonsense at home. Refuse and let the sender reword it.
  const title = String(d.title || '').trim().replace(/\s{2,}/g, ' ');
  if (!title) refusals.push({ code: 'no_title', message: 'a title is required' });
  if (title.length > 120) refusals.push({ code: 'title_long', message: `the title is ${title.length} characters; the bridge allows 120` });

  const freeParts = [];
  let note = '', body = '', steps = [];
  if (type === 'note') {
    const c = cleanText(d.body != null ? d.body : d.note);
    body = c.text; stripped.push(...c.stripped); freeParts.push(body);
    if (body.length > 2000) refusals.push({ code: 'body_long', message: 'the note body is over 2000 characters' });
  } else if (type === 'calendar_event') {
    const c = cleanText(d.note);
    note = c.text; stripped.push(...c.stripped); freeParts.push(note);
    if (note.length > 500) note = note.slice(0, 497).replace(/\s\S*$/, '') + '…';
  } else if (type === 'plan') {
    steps = (Array.isArray(d.steps) ? d.steps : []).map(s => {
      const c = cleanText(s); stripped.push(...c.stripped); return c.text;
    }).filter(Boolean);
    if (!steps.length) refusals.push({ code: 'no_steps', message: 'a plan needs at least one step' });
    if (steps.length > 12) refusals.push({ code: 'too_many_steps', message: `a plan takes at most 12 steps (this has ${steps.length})` });
    for (const s of steps) if (s.length > 120) refusals.push({ code: 'step_long', message: 'each step must be 120 characters or fewer' });
    freeParts.push(...steps);
  }

  const all = [title, ...freeParts].join(' \n ');

  // Sensitive content — checked on the UNCLEANED draft too, so a stripped date
  // cannot hide "incident on 2026-10-01".
  const sens = sensitiveHit([title, d.note, d.body, ...(Array.isArray(d.steps) ? d.steps : [])].join(' \n '));
  if (sens) refusals.push({ code: 'sensitive_' + sens, message: SENSITIVE_MSG[sens] });

  // Names — the check the bridge cannot do.
  const hit = guard && guard.nameHit ? guard.nameHit(all) : null;
  if (hit) {
    const what = hit.reason === 'family_email' ? 'a family email address'
      : hit.reason === 'staff_name' ? `a member of staff’s name (“${hit.matched}”)`
      : `a child’s or family member’s name (“${hit.matched}”)`;
    refusals.push({ code: hit.reason, message: `remove ${what} — no name crosses to home. Say the role instead.` });
  }
  if (TITLE_NAME_RE.test(all)) refusals.push({ code: 'titled_name', message: 'remove “Mr/Mrs/Ms/Dr + name” — the bridge refuses it too' });
  if (STREET_RE.test(all)) refusals.push({ code: 'address', message: 'remove the street address' });

  // Dates etc. must not survive in the title, and must be gone from free text.
  for (const re of DATE_RES) { re.lastIndex = 0; if (re.test(title)) { refusals.push({ code: 'date_in_title', message: 'take the date out of the title — it goes in the date field, which the bridge keeps' }); break; } }
  EMAIL_RE.lastIndex = 0; if (EMAIL_RE.test(title)) refusals.push({ code: 'email_in_title', message: 'take the email address out of the title' });
  PHONE_RE.lastIndex = 0; if (PHONE_RE.test(title)) refusals.push({ code: 'phone_in_title', message: 'take the phone number out of the title' });

  // Dates / times — only in their own fields, in the bridge's formats.
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  const item = { type, title };
  if (type === 'calendar_event') {
    const start = String(d.start || '').trim();
    if (!DATE_ONLY.test(start) && !DATE_TIME.test(start)) {
      refusals.push({ code: 'bad_start', message: 'start must be YYYY-MM-DD or YYYY-MM-DDTHH:MM' });
    }
    const end = String(d.end || '').trim();
    if (end && !DATE_ONLY.test(end) && !DATE_TIME.test(end)) {
      refusals.push({ code: 'bad_end', message: 'end must be YYYY-MM-DD or YYYY-MM-DDTHH:MM' });
    }
    if (end && DATE_TIME.test(end) && !DATE_TIME.test(start)) {
      refusals.push({ code: 'end_needs_time', message: 'an end with a time needs a start with a time' });
    }
    item.start = start;
    if (end) item.end = end;
    if (note) item.note = note;
    notes.push(genericTitleHint());
  } else if (type === 'todo') {
    const due = String(d.due || '').trim();
    if (due && !DATE_ONLY.test(due)) refusals.push({ code: 'bad_due', message: 'due must be YYYY-MM-DD' });
    if (due) item.due = due;
    const pri = String(d.priority || '').trim();
    if (pri) {
      if (!['low', 'normal', 'high'].includes(pri)) refusals.push({ code: 'bad_priority', message: 'priority must be low, normal or high' });
      else item.priority = pri;
    }
  } else if (type === 'plan') {
    item.steps = steps;
  } else if (type === 'note') {
    item.body = body;
  }

  const preview = type === 'calendar_event'
      ? [`${title}`, item.start + (item.end ? ' → ' + item.end : ''), note].filter(Boolean).join('\n')
    : type === 'todo'
      ? [`${title}`, item.due ? 'Due ' + item.due : '', item.priority ? 'Priority: ' + item.priority : ''].filter(Boolean).join('\n')
    : type === 'plan'
      ? [`${title}`, ...steps.map((s, i) => `${i + 1}) ${s}`)].join('\n')
      : [`${title}`, body].filter(Boolean).join('\n');

  const WHERE = {
    todo: 'Toby’s Pippin inbox (private to him)',
    calendar_event: 'Toby’s SHARED household calendar — others at home can see it',
    plan: 'Toby’s Pippin inbox, with the steps in his morning briefing',
    note: 'Toby’s morning briefing at home',
  };

  return {
    ok: refusals.length === 0,
    item,
    preview,
    lands: WHERE[type],
    refusals,
    stripped: [...new Set(stripped)],
    notes,
  };
}

module.exports = { buildGuard, prepare, cleanText, sensitiveHit, genericTitleHint, tokens, VOCAB_OK };
