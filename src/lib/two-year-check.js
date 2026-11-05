'use strict';
/**
 * two-year-check.js — b243 (2026-08-28)
 *
 * The Progress Check at Age Two: evidence gathering, drafting, and the rules
 * about what may and may not be written.
 *
 * ── WHAT THE STATUTE ACTUALLY ASKS FOR ──────────────────────────────────────
 * The EYFS statutory framework requires a SHORT WRITTEN SUMMARY for every child
 * between 24 and 36 months, covering the THREE PRIME AREAS and nothing else:
 *   • communication and language
 *   • physical development
 *   • personal, social and emotional development
 * The four specific areas (literacy, mathematics, understanding the world,
 * expressive arts and design) are NOT part of this check. PRIME_AREAS below is
 * the whole list, and the drafting prompt is built only from it — that is the
 * mechanism, not a note asking a model to behave.
 *
 * It must give an honest account of strengths AND of anything where progress is
 * less than expected, and where there is a concern it must be accompanied by a
 * targeted plan agreed with the parents (and the SENCO where appropriate).
 *
 * It goes to the parents, who are encouraged to take it to the health visitor
 * for the 2–2½ year review. That is why the trigger is the parent booking their
 * appointment rather than a date in our calendar.
 *
 * Characteristics of Effective Learning are Toby's addition (2026-08-28). They
 * are good practice rather than a statutory element of this check, so they get
 * their own short section describing HOW the child learns — never a fourth set
 * of judgements about whether they are on track.
 *
 * ── THE FABRICATION RULE ────────────────────────────────────────────────────
 * This document goes to a health visitor. An invented developmental claim is the
 * worst thing this build could produce — worse than producing nothing. So:
 *
 *   1. An area with too little evidence is NEVER sent to the model. It gets a
 *      deterministic "not enough evidence yet" paragraph naming what is missing.
 *      A model that is not asked cannot invent.
 *   2. Every area that IS drafted is given a numbered evidence list (OBS-n,
 *      TRK-n, NS-n, PA-n, TU-n) and told to cite. Citations are then checked
 *      against the list that was actually supplied; anything else is dropped.
 *   3. The evidence index is stored on the report row, so a practitioner reading
 *      the draft can see the record behind every line, and so can we, later.
 *
 * ── SOVEREIGNTY ─────────────────────────────────────────────────────────────
 * Named child, named nursery, developmental detail. It runs on the Ascent via
 * src/lib/sovereign-model.js, which refuses any host that is not a private or
 * Tailscale address — a parser, not a policy. There is no provider switch in
 * this file and AI_PROVIDER is deliberately not read: a demo edition configured
 * for Groq still drafts locally or not at all.
 */

// sovereign-model.js calls assertLocalHost() at REQUIRE time — deliberately, so a
// misconfigured endpoint fails loudly rather than halfway through a sweep. That
// makes it unsafe to require at the top of a file an Express server mounts: an
// edition with a bad OLLAMA_HOST would fail the mount and take the whole server
// with it. Load it when we actually draft, so a bad host becomes "this draft
// could not be produced, here are the records" instead of a dead portal.
function sovereign() { return require('./sovereign-model'); }

let canonicalArea;
try { ({ canonicalArea } = require('./area-gather')); } catch (_) { canonicalArea = () => null; }

// b268 — corrected age for children born premature (About Me → premature_weeks).
// Guarded the same way as area-gather above: a baked image predating the module
// must degrade to "no correction" rather than fail the mount.
let correctedAge;
try { ({ correctedAge } = require('./corrected-age')); }
catch (_) { correctedAge = () => ({ premature_weeks: null, corrected_age_months: null, corrected_label: '', note: null }); }

// ── The three prime areas ────────────────────────────────────────────────────
// `key` is what goes in reports.content.sections[].key and stays stable forever.
// `heading` is parent-facing prose, so it is sentence case, not Ofsted case.
const PRIME_AREAS = [
  { key: 'communication_language',
    heading: 'Communication and language',
    // area-gather's canonical spelling, which is what canonicalArea() returns
    canonical: 'Communication & Language',
    // Everything a practitioner might have typed. Matched case-insensitively
    // after canonicalArea() has had its go.
    match: /^(c\s*&?\s*l|cl|communication)/i,
    plain: 'listening, understanding, and talking' },
  { key: 'physical_development',
    heading: 'Physical development',
    canonical: 'Physical Development',
    match: /^(pd|physical)/i,
    plain: 'moving, balance, and using their hands' },
  { key: 'pse_development',
    heading: 'Personal, social and emotional development',
    canonical: 'Personal, Social & Emotional Development',
    match: /^(psed?|pse|personal)/i,
    plain: 'feelings, friendships, and doing things for themselves' },
];
const PRIME_KEYS = PRIME_AREAS.map(a => a.key);

// 24–36 months. The check is for children in that band; outside it the parents
// app explains why rather than hiding the section.
const AGE_MIN_MONTHS = 24;
const AGE_MAX_MONTHS = 36;

// b244 (2026-08-28) — MAY be written vs WILL be written. Two different numbers,
// and b243 only had the first one.
//
// AGE_MIN/MAX above are the STATUTORY WINDOW: the framework requires the summary
// somewhere between 24 and 36 months, so 24 is the earliest a check can exist.
// DUE_MONTHS is when LADN expects it done — 30 months, 2½ years, Toby's schedule
// verbatim on 2026-08-28. It is not an arbitrary midpoint: the health visitor's
// review is a 2–2½ year appointment, and the whole reason this document exists is
// to be in the family's hand when they walk into it. A check written at 35 months
// is inside the statute and three months too late to be any use.
//
// So: the window is unchanged and still governs whether a check CAN be started.
// This constant governs when b244's schedule says one is owed
// (src/lib/report-cycle.js, report_cycle_two_year_due_months).
const DUE_MONTHS = 30;

// b528 (2026-10-26) — when a PARENT may ask for it, which is not the same number
// as either of the two above.
//
// Toby, 2026-10-26: "currently the baby room do it right before they turn two,
// but we're finding children are having their progress checks closer to 3 than
// 2." The health visitor's 2-year review is booked by the family, and the letter
// arrives WEEKS BEFORE the child turns two. b243 refused a request until the day
// of the second birthday (eligibility() below), so a parent holding an
// appointment letter for the week after that birthday was told the check "is not
// available for this child at the moment" and had nothing to press. The nursery
// then noticed late, and wrote the check whenever it noticed — which is how they
// end up nearer three.
//
// So the REQUEST window opens at 18 months. It does not move the statutory
// window: a request below 24 months is parked (status 'requested', nothing
// drafted, nobody told "this needs you") until the child reaches the window or
// the appointment comes within DRAFT_LEAD_DAYS — see
// src/services/two-year-check-draft-queue.js. The document itself is still
// written between 24 and 36 months, by a person, exactly as before.
const REQUEST_MIN_MONTHS = 18;

// How long before the appointment a parked request starts drafting. An
// appointment at 23 months 2 weeks is real and the summary has to be in the
// family's hand for it, so the appointment date overrides the age floor.
const DRAFT_LEAD_DAYS = 28;

/** When this child's check is expected — 2½, not 2. */
function dueDate(dob) {
  if (!dob) return null;
  const d = (dob instanceof Date) ? new Date(dob) : new Date(dob);
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + DUE_MONTHS);
  return ymd(d);
}

// How far back evidence is gathered. Capped at 12 months so a child who has been
// with us since babyhood does not have a two-year-old's summary written from
// what they did at nine months old.
const EVIDENCE_MONTHS = 12;

// The model. Toby asked for "big local model": ai-models.js role 'heavy',
// resolved per draft (b333 — the model this shipped on came off the Ascent).
// Overridable through settings.ai_model_overrides, but only ever to another
// local model: the host guard in sovereign-model.js is what stops this reaching
// anything hosted.
const ai = require('./ai-models');
const ROLE = 'heavy';
const TIMEOUT_MS = parseInt(process.env.TWO_YEAR_CHECK_TIMEOUT_MS || '300000', 10);

// ── Edition gate ─────────────────────────────────────────────────────────────
/**
 * Same three lines as editionFamily() in src/routes/setup.js — duplicated rather
 * than imported because that module exports an Express router, and requiring a
 * router for a string comparison drags its middleware in with it.
 * A secondary school has no 2-year check; a nursery on the 4-portal `ht` image
 * (Children's Corner) does, which is what WREN_EDITION_FAMILY exists for.
 */
function editionFamily() {
  const fam = String(process.env.WREN_EDITION_FAMILY || '').toLowerCase();
  if (['eyfs', 'primary', 'secondary'].includes(fam)) return fam;
  const ed = String(process.env.WREN_EDITION || '').toLowerCase();
  const schema = String(process.env.PG_SCHEMA || '').toLowerCase();
  if (ed === 'secondary' || schema.includes('secondary')) return 'secondary';
  if (ed === 'primary' || ed === 'ht' || schema.includes('primary')) return 'primary';
  return 'eyfs'; // eyfs / ladn / demo_eyfs / nursery
}
function isEyfsEdition() { return editionFamily() === 'eyfs'; }

// ── Ages and dates ───────────────────────────────────────────────────────────
/**
 * Whole months between two dates.
 * pg returns DATE as a local-midnight JS Date, so read it with LOCAL getters —
 * toISOString() would shift a BST date back a day and can move a child across
 * the 24-month boundary on their birthday.
 */
function ageInMonths(dob, on) {
  if (!dob) return null;
  const d = (dob instanceof Date) ? dob : new Date(dob);
  const t = on ? ((on instanceof Date) ? on : new Date(on)) : new Date();
  if (isNaN(d) || isNaN(t)) return null;
  let m = (t.getFullYear() - d.getFullYear()) * 12 + (t.getMonth() - d.getMonth());
  if (t.getDate() < d.getDate()) m -= 1;
  return m;
}

/** yyyy-mm-dd from a Date, using local getters (see the note in ageInMonths). */
function ymd(v) {
  if (!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function longDate(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Is this child in the statutory window, and if not, why not — the parents app
 * shows the reason rather than silently hiding the section.
 */
function eligibility(dob, on) {
  const months = ageInMonths(dob, on);
  if (months == null) {
    return { eligible: false, months: null, reason: 'no_dob',
      message: "We do not have a date of birth on file, so we cannot work out whether this check is due yet. Please contact the office." };
  }
  // b244: both dates, always. `due_from` is when the check may first be written
  // (the statutory window opening at 24 months); `due_on` is when we expect it
  // done (30 months, 2½). A parent whose appointment is at 25 months can still
  // ask for it today — that is the whole point of the window — but nobody should
  // be told the document is "due at two" when the nursery's own schedule says
  // two and a half.
  const openOn = dob ? new Date(dob) : null;
  if (openOn) openOn.setMonth(openOn.getMonth() + AGE_MIN_MONTHS);
  const expectedOn = dueDate(dob);

  if (months < AGE_MIN_MONTHS) {
    return { eligible: false, months, reason: 'too_young', due_from: ymd(openOn), due_on: expectedOn,
      message: `This check is written for children between two and three. We can start it from ${longDate(openOn)}, when your child turns two, and we aim to have it done by about two and a half — in time for your health visitor review.` };
  }
  if (months > AGE_MAX_MONTHS) {
    return { eligible: false, months, reason: 'too_old', due_from: ymd(openOn), due_on: expectedOn,
      message: 'This check is for children aged two to three, and your child is now over three. If you still need a written summary for a health appointment, please ask us and we will put one together.' };
  }
  return { eligible: true, months, reason: 'ok', due_from: ymd(openOn), due_on: expectedOn, message: null };
}

/**
 * b528 — what the PARENTS APP should show this family, which is a different
 * question from eligibility() above.
 *
 * eligibility() answers "may this document be written today?" (the statute:
 * 24–36 months). This answers "what does this parent see, and can they press
 * the button?" — and the answer is never "nothing", because a family who has
 * never heard of the progress check at two cannot ask for it at the right time.
 *
 *   coming_up   under 18 months — the short version: this is coming, here is what it is.
 *   can_request 18–36 months — the full explanation and the button.
 *   too_old     over 36 months — the window has closed; ask us.
 *   no_dob      we cannot work it out.
 *
 * `parked` is true when a request WOULD be accepted but the check cannot be
 * written yet (under 24 months). The copy has to say so, or a parent who presses
 * the button at 19 months waits five months wondering why nothing arrived.
 */
function requestStage(dob, on) {
  const months = ageInMonths(dob, on);
  const el = eligibility(dob, on);
  if (months == null) return { stage: 'no_dob', months: null, can_request: false, parked: false, eligibility: el };
  if (months > AGE_MAX_MONTHS) return { stage: 'too_old', months, can_request: false, parked: false, eligibility: el };
  if (months < REQUEST_MIN_MONTHS) {
    return { stage: 'coming_up', months, can_request: false, parked: false, eligibility: el,
      request_from: ymd(addMonths(dob, REQUEST_MIN_MONTHS)) };
  }
  return { stage: 'can_request', months, can_request: true,
    parked: months < AGE_MIN_MONTHS, eligibility: el,
    request_from: ymd(addMonths(dob, REQUEST_MIN_MONTHS)) };
}

/** dob + n months, as a Date. Local getters throughout (see ageInMonths). */
function addMonths(dob, n) {
  if (!dob) return null;
  const d = (dob instanceof Date) ? new Date(dob) : new Date(dob);
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + n);
  return d;
}

/**
 * b528 — is this parked request ready to be drafted?
 * Either the child has reached the statutory window, or their appointment is
 * close enough that waiting would make the document useless.
 */
function draftDueNow(dob, appointmentDate, on) {
  const months = ageInMonths(dob, on);
  if (months == null) return true;            // no dob: let a human deal with it now
  if (months >= AGE_MIN_MONTHS) return true;
  if (appointmentDate) {
    const appt = new Date(appointmentDate);
    const now = on ? new Date(on) : new Date();
    if (!isNaN(appt) && (appt - now) <= DRAFT_LEAD_DAYS * 86400000) return true;
  }
  return false;
}

/**
 * b528 — which room writes the two-year check?
 *
 * Toby: "it's the preschool staff that write it up". Resolved FROM THE ROOMS
 * TABLE, never a hard-coded id: the room whose age band contains the age the
 * check is expected at (DUE_MONTHS, 30). At LADN that is Pre-school (24–60);
 * Baby Room (6–24) does not contain 30. Any setting with sensibly configured
 * rooms gets the right answer, and a setting with one room gets that one room.
 *
 * Returns null rather than guessing when no room's band contains it — the
 * caller falls back to managers, which is the "never silently dropped" rule.
 */
async function resolveCheckRoom(db, atMonths) {
  const m = atMonths == null ? DUE_MONTHS : atMonths;
  const { rows } = await db.query(
    `SELECT id, name, min_age_months, max_age_months
       FROM rooms
      WHERE COALESCE(min_age_months, 0) <= $1
        AND (max_age_months IS NULL OR max_age_months > $1)
      ORDER BY COALESCE(min_age_months, 0) DESC, id
      LIMIT 1`, [m]);
  return rows[0] || null;
}

// ── Which prime area does a label belong to? ─────────────────────────────────
/**
 * Observations and framework rows spell areas half a dozen ways ("PSED",
 * "Personal, Social and Emotional Development", "Personal, Social & Emotional").
 * area-gather.canonicalArea() handles the known aliases; the regex is the
 * fallback for spellings it has not seen. Returns a PRIME_AREAS key, or null for
 * anything that is not a prime area — which is how the four specific areas get
 * left out without a separate exclusion list.
 */
function primeAreaKey(label) {
  const raw = String(label == null ? '' : label).trim();
  if (!raw) return null;
  const canon = canonicalArea(raw);
  if (canon) {
    const hit = PRIME_AREAS.find(a => a.canonical === canon);
    return hit ? hit.key : null;
  }
  const hit = PRIME_AREAS.find(a => a.match.test(raw));
  return hit ? hit.key : null;
}

/** The prime areas an observation touches, from its eyfs_areas tags. */
function primeAreasOfObservation(o) {
  const tags = Array.isArray(o.eyfs_areas) ? o.eyfs_areas : [];
  const keys = new Set();
  for (const t of tags) { const k = primeAreaKey(t); if (k) keys.add(k); }
  return [...keys];
}

// ── Evidence gathering ───────────────────────────────────────────────────────
/**
 * Everything Wren holds about this child that is relevant to the three prime
 * areas, in the evidence window. Deterministic — no model involved — so the same
 * child always produces the same evidence pack, and every entry carries the id
 * of the row it came from.
 *
 * @param {object} db   pg pool (search_path already set by src/db/pool.js)
 * @param {number} childId
 * @param {object} [opts] { on: Date — "as at", for testing }
 */
async function gatherEvidence(db, childId, opts = {}) {
  const on = opts.on ? new Date(opts.on) : new Date();
  const from = new Date(on);
  from.setMonth(from.getMonth() - EVIDENCE_MONTHS);

  const childRes = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
           c.room_id, c.key_person_id, c.start_date, c.send_needs, c.sen_needs,
           r.name AS room_name,
           kp.first_name AS kp_first, kp.last_name AS kp_last, kp.role AS kp_role,
           cam.premature_weeks
      FROM children c
      LEFT JOIN rooms r  ON r.id = c.room_id
      LEFT JOIN staff kp ON kp.id = c.key_person_id
      LEFT JOIN child_about_me cam ON cam.child_id = c.id
     WHERE c.id = $1`, [childId]);
  if (!childRes.rows.length) throw new Error('Child not found');
  const c = childRes.rows[0];

  // Start of the window: never before the child joined us — we cannot write
  // about what happened somewhere else.
  const windowFrom = (c.start_date && new Date(c.start_date) > from) ? new Date(c.start_date) : from;

  const [obsRes, trkRes, coelRes, nsRes, paRes] = await Promise.all([
    // Published observations only. A draft or a returned observation is not yet
    // an agreed record of what happened.
    db.query(`
      SELECT o.id, o.title, o.observation_text, o.analysis, o.next_steps,
             o.eyfs_areas, o.created_at, o.termly_update, o.baseline,
             -- b528: the evidence PANEL (src/routes/report-evidence.js) shows the
             -- practitioner the photos beside the words they are writing. Bare
             -- paths only: the response signer in server-unified.js signs them on
             -- the way out, and nothing in the drafting prompt reads this field.
             o.photo_urls,
             COALESCE(o.author_name, s.first_name || ' ' || s.last_name) AS author_name
        FROM observations o
        LEFT JOIN staff s ON s.id = o.staff_id
       WHERE o.child_id = $1
         AND o.created_at >= $2
         AND COALESCE(o.review_status, 'published') = 'published'
         AND COALESCE(o.dsl_only, false) = false
       ORDER BY o.created_at DESC
       LIMIT 60`, [childId, windowFrom]),

    // Framework tracker, prime areas only, most recently assessed first.
    db.query(`
      SELECT t.id, t.framework, t.area, t.aspect, t.age_range, t.statement,
             t.status, t.assessed_at, t.notes
        FROM framework_tracker t
       WHERE t.child_id = $1
         AND COALESCE(t.framework, '') <> 'coel'
       ORDER BY t.assessed_at DESC NULLS LAST, t.id DESC
       LIMIT 400`, [childId]),

    // Characteristics of Effective Learning, tracked as their own framework.
    db.query(`
      SELECT t.id, t.area, t.aspect, t.statement, t.status, t.assessed_at, t.notes
        FROM framework_tracker t
       WHERE t.child_id = $1 AND t.framework = 'coel'
       ORDER BY t.assessed_at DESC NULLS LAST, t.id DESC
       LIMIT 60`, [childId]),

    // Next steps still open, plus the ones recently completed (which are
    // evidence of progress, not of a gap).
    db.query(`
      SELECT n.id, n.description, n.status, n.due_by, n.created_at,
             n.framework_statement_id, fs.area AS fs_area,
             o.eyfs_areas AS obs_areas
        FROM next_steps n
        LEFT JOIN framework_statements fs ON fs.id = n.framework_statement_id
        LEFT JOIN observations o ON o.id = n.observation_id
       WHERE n.child_id = $1 AND n.created_at >= $2
       ORDER BY (n.status = 'pending') DESC, n.created_at DESC
       LIMIT 60`, [childId, windowFrom]),

    // Planned activities aimed at this child specifically.
    db.query(`
      SELECT p.id, p.plan_date, p.slot, p.status,
             COALESCE(p.title, p.custom_title, ca.name) AS title,
             COALESCE(p.description, p.custom_notes, ca.description) AS description,
             ca.eyfs_areas AS activity_areas,
             n.description AS next_step_text,
             fs.area AS ns_area,
             no.eyfs_areas AS ns_obs_areas
        FROM planned_activities p
        LEFT JOIN curriculum_activities ca ON ca.id = p.activity_id
        LEFT JOIN next_steps n ON n.id = p.next_step_id
        LEFT JOIN framework_statements fs ON fs.id = n.framework_statement_id
        LEFT JOIN observations no ON no.id = n.observation_id
       WHERE p.child_id = $1 AND p.plan_date >= $2
       ORDER BY p.plan_date DESC
       LIMIT 40`, [childId, ymd(windowFrom)]),
  ]);

  // ── Index every record under a stable citation ref ─────────────────────────
  const index = {};
  const byArea = {};
  for (const k of PRIME_KEYS) byArea[k] = { observations: [], tracker: [], next_steps: [], planned: [], termly: [] };
  const unplaced = { observations: [], tracker: [], next_steps: [], planned: [] };

  for (const o of obsRes.rows) {
    const ref = `OBS-${o.id}`;
    const areas = primeAreasOfObservation(o);
    const item = {
      ref, id: o.id, date: ymd(o.created_at), title: o.title || null,
      text: String(o.observation_text || '').trim(),
      analysis: o.analysis ? String(o.analysis).trim() : null,
      next_steps: o.next_steps ? String(o.next_steps).trim() : null,
      author: o.author_name || null,
      termly_update: !!o.termly_update,
      photos: Array.isArray(o.photo_urls) ? o.photo_urls.filter(Boolean) : [],
      areas,
    };
    index[ref] = { type: 'observation', id: o.id, date: item.date, label: item.title || 'Observation' };
    if (!areas.length) unplaced.observations.push(item);
    for (const k of areas) {
      byArea[k].observations.push(item);
      // A Termly Update is an observation carrying a flag, not a separate table.
      if (o.termly_update) byArea[k].termly.push(item);
    }
  }

  for (const t of trkRes.rows) {
    const k = primeAreaKey(t.area);
    const ref = `TRK-${t.id}`;
    const item = {
      ref, id: t.id, area: t.area, aspect: t.aspect || null, age_range: t.age_range || null,
      statement: String(t.statement || '').trim(), status: t.status || 'not_yet',
      assessed: ymd(t.assessed_at), notes: t.notes ? String(t.notes).trim() : null,
    };
    index[ref] = { type: 'framework_tracker', id: t.id, date: item.assessed, label: item.statement.slice(0, 90) };
    if (k) byArea[k].tracker.push(item); else unplaced.tracker.push(item);
  }

  const coel = coelRes.rows.map(t => {
    const ref = `COEL-${t.id}`;
    index[ref] = { type: 'framework_tracker', id: t.id, date: ymd(t.assessed_at), label: String(t.statement || '').slice(0, 90) };
    return { ref, id: t.id, characteristic: t.area, aspect: t.aspect || null,
             statement: String(t.statement || '').trim(), status: t.status || 'not_yet',
             assessed: ymd(t.assessed_at) };
  });

  for (const n of nsRes.rows) {
    const ref = `NS-${n.id}`;
    // Framework link first, then the parent observation's tags, then the words.
    let k = primeAreaKey(n.fs_area);
    if (!k && Array.isArray(n.obs_areas)) {
      for (const a of n.obs_areas) { k = primeAreaKey(a); if (k) break; }
    }
    const item = { ref, id: n.id, description: String(n.description || '').trim(),
                   status: n.status, due_by: ymd(n.due_by), created: ymd(n.created_at) };
    index[ref] = { type: 'next_step', id: n.id, date: item.created, label: item.description.slice(0, 90) };
    if (k) byArea[k].next_steps.push(item); else unplaced.next_steps.push(item);
  }

  for (const p of paRes.rows) {
    const ref = `PA-${p.id}`;
    let k = primeAreaKey(p.ns_area);
    if (!k && Array.isArray(p.ns_obs_areas)) { for (const a of p.ns_obs_areas) { k = primeAreaKey(a); if (k) break; } }
    if (!k && Array.isArray(p.activity_areas)) { for (const a of p.activity_areas) { k = primeAreaKey(a); if (k) break; } }
    const item = { ref, id: p.id, date: ymd(p.plan_date), title: p.title || null,
                   description: p.description ? String(p.description).trim() : null,
                   status: p.status || 'planned', from_next_step: p.next_step_text || null };
    index[ref] = { type: 'planned_activity', id: p.id, date: item.date, label: item.title || 'Planned activity' };
    if (k) byArea[k].planned.push(item); else unplaced.planned.push(item);
  }

  const months = ageInMonths(c.date_of_birth, on);
  const _ca = correctedAge(months, c.premature_weeks);   // b268
  return {
    generated_at: on.toISOString(),
    window: { from: ymd(windowFrom), to: ymd(on), months: EVIDENCE_MONTHS },
    child: {
      id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      preferred_name: c.preferred_name || null,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      known_as: (c.preferred_name || c.first_name || '').trim(),
      date_of_birth: ymd(c.date_of_birth),
      age_months: months,
      // b268 — a child born early is developmentally younger than their birthday
      // says. The statutory window is still chronological (the check is due
      // between 24 and 36 months however early they arrived), so this changes
      // what the pack SAYS, never whether the check is due.
      premature_weeks: _ca.premature_weeks,
      corrected_age_months: _ca.corrected_age_months,
      corrected_age_label: _ca.corrected_label || null,
      corrected_age_note: _ca.note,
      room_id: c.room_id, room_name: c.room_name || null,
      send_needs: !!c.send_needs, sen_needs: c.sen_needs || null,
    },
    keyperson: c.key_person_id
      ? { id: c.key_person_id, name: `${c.kp_first || ''} ${c.kp_last || ''}`.trim(), role: c.kp_role || null }
      : null,
    areas: byArea,
    coel,
    unplaced,
    index,
    counts: {
      observations: obsRes.rows.length, tracker: trkRes.rows.length,
      next_steps: nsRes.rows.length, planned: paRes.rows.length, coel: coel.length,
    },
  };
}

// ── Is there enough to write about? ──────────────────────────────────────────
/**
 * An area is written by the model only if there is something real behind it:
 * at least one observation tagged to that area, OR at least two tracker
 * statements that have actually been assessed (anything other than not_yet).
 *
 * Below that bar the section is written HERE, deterministically, and says so.
 * "We have not gathered enough yet to write about this" is a true sentence a
 * health visitor can act on. An invented one is not.
 */
function areaSufficiency(area) {
  const obs = area.observations.length;
  const assessed = area.tracker.filter(t => t.status && t.status !== 'not_yet').length;
  const sufficient = obs >= 1 || assessed >= 2;
  return { sufficient, observations: obs, assessed_statements: assessed,
           tracker: area.tracker.length, next_steps: area.next_steps.length,
           planned: area.planned.length };
}

function insufficientText(areaDef, ev) {
  const who = ev.child.known_as || 'your child';
  return `We do not yet have enough recorded evidence to write honestly about ${who}'s ${areaDef.heading.toLowerCase()} ` +
    `(${areaDef.plain}). Rather than fill this section with something we cannot show you the evidence for, we have left it open. ` +
    `${who}'s key person will gather observations in this area over the coming weeks and can share what they find with you ` +
    `and, if it would help, send an updated summary before or after your appointment.`;
}

// ── The prompt ───────────────────────────────────────────────────────────────
function evidenceBlock(areaDef, area) {
  const lines = [];
  for (const o of area.observations.slice(0, 12)) {
    const bits = [o.text];
    if (o.analysis) bits.push(`Practitioner analysis: ${o.analysis}`);
    lines.push(`[${o.ref}] ${o.date} — ${o.title ? o.title + ': ' : ''}${bits.join(' ')}`.slice(0, 900));
  }
  const assessed = area.tracker.filter(t => t.status && t.status !== 'not_yet');
  for (const t of assessed.slice(0, 25)) {
    lines.push(`[${t.ref}] ${t.age_range ? t.age_range + ' — ' : ''}${t.statement} → ${t.status}${t.notes ? ' (' + t.notes + ')' : ''}`.slice(0, 400));
  }
  const notYet = area.tracker.filter(t => t.status === 'not_yet');
  if (notYet.length) {
    // Deliberately NOT in square brackets. The first cut wrote "[not yet
    // observed]" and the model faithfully copied it through as though it were a
    // citation — checkCitations only strips things shaped like [ABC-123], so it
    // survived into the printed PDF. Anything in this block that is not a real
    // reference must not look like one.
    lines.push(`NOTE - not yet observed: ${notYet.length} statement(s) in this area are recorded as not yet seen, including: ` +
      notYet.slice(0, 5).map(t => t.statement).join('; ').slice(0, 400));
  }
  for (const n of area.next_steps.slice(0, 10)) {
    lines.push(`[${n.ref}] Next step (${n.status}): ${n.description}`.slice(0, 300));
  }
  for (const p of area.planned.slice(0, 8)) {
    lines.push(`[${p.ref}] Planned activity ${p.date}: ${p.title || ''}${p.description ? ' — ' + p.description : ''}`.slice(0, 300));
  }
  for (const t of area.termly.slice(0, 4)) {
    lines.push(`[${t.ref}] Progress update ${t.date}: ${String(t.text).slice(0, 500)}`);
  }
  return lines.length ? lines.join('\n') : '(no records)';
}

const SYSTEM = [
  'You are helping an early years practitioner in an English nursery draft the statutory EYFS',
  'Progress Check at Age Two. Your draft will be read, edited and signed by that practitioner,',
  'and then given to the child\'s parents to take to their health visitor appointment.',
  '',
  'ABSOLUTE RULES:',
  '1. Write ONLY what the supplied records support. Never infer, extrapolate or invent a',
  '   developmental claim. If the records do not show something, do not say it.',
  '2. Cite the reference in square brackets (for example [OBS-412]) after each factual claim.',
  '   Use only references that appear in the records you are given.',
  '3. Cover only the area you are asked about. Do not mention any other area of learning.',
  '4. Write warmly and plainly, for a parent, in British English. Use the child\'s name.',
  '   Never copy a square-bracketed phrase that is not a reference (for example the word',
  '   NOTE lines) into your answer.',
  '   No jargon, no acronyms, no Ofsted language, no bullet points, no headings.',
  '5. Be honest about what is not yet secure. A parent and a health visitor need the real',
  '   picture, not reassurance.',
].join('\n');

function areaPrompt(areaDef, area, ev) {
  const name = ev.child.known_as || ev.child.first_name;
  const suff = areaSufficiency(area);
  return [
    `Child: ${name}, aged ${ev.child.age_months} months.`,
    // b268 — without this line the model judges a premature baby against the
    // wrong expectation, in a document that goes to a health visitor.
    ev.child.corrected_age_note ? ev.child.corrected_age_note : '',
    `Area: ${areaDef.heading} — that is, ${areaDef.plain}.`,
    `Records held between ${ev.window.from} and ${ev.window.to}:`,
    '',
    evidenceBlock(areaDef, area),
    '',
    'Write TWO short paragraphs (120–180 words in total) for the parents about this child in',
    'this area only:',
    '  • what they can do now and what they enjoy, with references;',
    '  • anything that is not yet secure, or that we are still working on, with references.',
    suff.assessed_statements === 0
      ? 'Note: no framework statements have been assessed in this area, so base the summary on the observations alone and say plainly that formal assessment in this area is still building.'
      : '',
    'Then, on a new final line, write exactly one of:',
    'CONCERN: yes    — if the records show progress that is less than expected for this age',
    'CONCERN: no     — if they do not',
    'Do not explain the CONCERN line.',
  ].filter(Boolean).join('\n');
}

function coelPrompt(ev) {
  const name = ev.child.known_as || ev.child.first_name;
  const lines = ev.coel.filter(c => c.status && c.status !== 'not_yet')
    .slice(0, 20)
    .map(c => `[${c.ref}] ${c.characteristic}${c.aspect ? ' / ' + c.aspect : ''}: ${c.statement} → ${c.status}`);
  // With no COEL tracking, fall back to what the observations themselves show
  // about HOW the child engages — still real records, still cited.
  const obsLines = [];
  for (const k of PRIME_KEYS) {
    for (const o of ev.areas[k].observations.slice(0, 4)) {
      obsLines.push(`[${o.ref}] ${o.date} — ${String(o.text).slice(0, 400)}`);
    }
  }
  return [
    `Child: ${name}, aged ${ev.child.age_months} months.`,
    'Describe HOW this child learns — the Characteristics of Effective Learning:',
    'playing and exploring, active learning, and creating and thinking critically.',
    'This is a description of their learning style, NOT a judgement about whether they are on track.',
    '',
    'Records:',
    (lines.length ? lines.join('\n') : '(no characteristics tracked)'),
    (obsLines.length ? '\nObservations:\n' + [...new Set(obsLines)].slice(0, 10).join('\n') : ''),
    '',
    'Write ONE short paragraph (70–110 words) for the parents, with references in square brackets.',
    'If the records genuinely do not show how this child approaches their learning, reply with exactly:',
    'NOT ENOUGH EVIDENCE',
  ].filter(Boolean).join('\n');
}

// ── Citation checking ────────────────────────────────────────────────────────
const REF_RE = /\[([A-Z]+-\d+)\]/g;
// Any short square-bracketed span. Used to catch things that are NOT references
// but that the model produced anyway — see checkCitations.
const ANY_BRACKET_RE = /\[[^[\]\n]{1,60}\]/g;

/**
 * Keep the citations that point at real records; remove everything else in
 * square brackets.
 *
 * Two failure modes, both seen on the Ascent during b243 testing:
 *   • a reference to a record that does not exist — the tell for an invented
 *     claim, so it is counted and shown to the practitioner, never swallowed;
 *   • a NON-reference the model copied out of the evidence block because it
 *     looked like the citation pattern. The first cut fed it a line beginning
 *     "[not yet observed]" and that phrase printed, verbatim, in the parents'
 *     PDF. Removing the brackets from the source line was not enough: the next
 *     run produced "[NOTE]" from a line that had no brackets at all. A model
 *     shown a citation format will reach for it, so the only reliable rule is
 *     that anything bracketed which is not a resolvable reference goes.
 *
 * Practitioner-typed text never passes through here — this runs on the model's
 * output, at draft time, before a human ever sees it.
 */
function checkCitations(text, allowed) {
  const cited = [];
  const invalid = [];   // reference-SHAPED but pointing at nothing — a hallucination tell
  const stray = [];     // not a reference at all — a copied marker, cosmetic
  const cleaned = String(text || '').replace(ANY_BRACKET_RE, (m) => {
    const inner = m.slice(1, -1).trim();
    if (/^[A-Z]+-\d+$/.test(inner)) {
      if (allowed.has(inner)) { if (!cited.includes(inner)) cited.push(inner); return m; }
      invalid.push(inner);
      return '';
    }
    stray.push(inner);
    return '';
  }).replace(/\s+([.,;:])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
  // The two are kept apart on purpose. "[NOTE]" is untidy; "[OBS-999]" means the
  // model referred to a record that does not exist, which is the signal a
  // practitioner must actually act on. Merging them would bury it in noise.
  return { text: cleaned, cited, invalid, stray };
}

/** Pull the model's CONCERN verdict off the end and return the prose without it. */
function splitConcern(text) {
  const m = /^\s*CONCERN:\s*(yes|no)\s*$/im.exec(String(text || ''));
  const concern = m ? m[1].toLowerCase() === 'yes' : null;
  const body = String(text || '').replace(/^\s*CONCERN:\s*(yes|no)\s*$/gim, '').trim();
  return { concern, body };
}

// ── Drafting ─────────────────────────────────────────────────────────────────
/**
 * Build the full draft. Returns the object that becomes reports.content.
 *
 * Never throws for a model failure. If the Ascent is down or slow, the draft
 * still comes back — with the evidence, the headings, and an explicit note in
 * each undrafted section telling the keyperson to write it themselves. A
 * statutory document must not be blocked by an inference box being busy; the
 * human gate is what makes it valid either way.
 */
async function buildDraft(ev, opts = {}) {
  const allowed = new Set(Object.keys(ev.index));
  const name = ev.child.known_as || ev.child.first_name || 'Your child';
  const model = opts.model || ai.model(ROLE);
  const errors = [];
  let host = null;
  let generate = null;
  try {
    const sm = sovereign();
    host = sm.assertLocalHost(sm.OLLAMA);
    generate = sm.generate;
  } catch (e) { errors.push(`host: ${e.message}`); }

  const sections = [];

  // 1 — the identifying block. Deterministic, never modelled. This is what makes
  // the printed PDF usable at a health appointment: who, when, born when, by whom.
  const aboutLines = [
    `Child: ${ev.child.name}`,
    `Date of birth: ${longDate(ev.child.date_of_birth)}${ev.child.age_months != null ? `  (aged ${ev.child.age_months} months at this check)` : ''}`,
    // b268 — a health visitor reading this at the appointment needs to know the
    // child arrived early before they read a word of the summaries below.
    ev.child.premature_weeks
      ? `Born ${ev.child.premature_weeks} week${ev.child.premature_weeks === 1 ? '' : 's'} early` +
        (ev.child.corrected_age_months != null
          ? ` — corrected age ${ev.child.corrected_age_months} months. Development in this check should be read against the corrected age, not the actual age.`
          : '. Past two years, so age is no longer corrected.')
      : null,
    ev.child.room_name ? `Room: ${ev.child.room_name}` : null,
    ev.keyperson ? `Key person: ${ev.keyperson.name}${ev.keyperson.role ? ' — ' + roleLabel(ev.keyperson.role) : ''}` : 'Key person: to be confirmed',
    opts.appointment_date ? `Health visitor appointment: ${longDate(opts.appointment_date)}` : null,
    `Records considered: ${ev.window.from} to ${ev.window.to}`,
  ].filter(Boolean);
  sections.push({ key: 'about', heading: 'About this check', body: aboutLines.join('\n'), generated: false });

  sections.push({
    key: 'what_this_is',
    heading: 'What this check is',
    generated: false,
    body: [
      `This is the progress check at age two, which every nursery in England must write for children between two and three years old.`,
      `It is a short summary of how ${name} is getting on in the three areas that matter most at this age: communication and language,`,
      `physical development, and personal, social and emotional development. It is not a test and it is not a full report on everything`,
      `${name} does with us.`,
      ``,
      `Please take this with you to your health visitor review. It is designed to sit alongside the health check so that the people`,
      `looking after ${name} are all working from the same picture.`,
    ].join(' ').replace(/\s+\n/g, '\n'),
  });

  // 2 — the three prime areas, in statutory order.
  const concerns = [];
  for (const areaDef of PRIME_AREAS) {
    const area = ev.areas[areaDef.key];
    const suff = areaSufficiency(area);
    if (!suff.sufficient) {
      sections.push({
        key: areaDef.key, heading: areaDef.heading, body: insufficientText(areaDef, ev),
        generated: false, sufficient: false, evidence: [], evidence_summary: suff, concern: null,
      });
      continue;
    }
    let body = '', cited = [], invalid = [], stray = [], concern = null, generated = false;
    try {
      if (!host || !generate) throw new Error('local model unavailable');
      const raw = await generate({
        model, system: SYSTEM, prompt: areaPrompt(areaDef, area, ev),
        temperature: 0.2, numPredict: 500, timeoutMs: TIMEOUT_MS,
      });
      const split = splitConcern(raw);
      const checked = checkCitations(split.body, allowed);
      body = checked.text; cited = checked.cited; invalid = checked.invalid; stray = checked.stray;
      concern = split.concern;
      generated = true;
      if (!body) throw new Error('model returned nothing usable');
    } catch (e) {
      errors.push(`${areaDef.key}: ${e.message}`);
      body = `The automatic draft for this section could not be produced (${e.message}). ` +
             `${name}'s key person will write this section. The records gathered for it are listed with this draft.`;
      generated = false;
    }
    if (concern) concerns.push(areaDef.key);
    sections.push({
      key: areaDef.key, heading: areaDef.heading, body,
      generated, sufficient: true, concern,
      evidence: cited.length ? cited : evidenceRefs(area),
      invalid_citations: invalid,
      stray_markers: stray,
      evidence_summary: suff,
    });
  }

  // 3 — Characteristics of Effective Learning. Toby's addition; description, not
  // judgement, and it is allowed to be absent.
  {
    let body = '', cited = [], generated = false;
    const anyEvidence = ev.coel.some(c => c.status && c.status !== 'not_yet') ||
      PRIME_KEYS.some(k => ev.areas[k].observations.length);
    if (anyEvidence && host && generate) {
      try {
        const raw = await generate({
          model, system: SYSTEM, prompt: coelPrompt(ev),
          temperature: 0.2, numPredict: 320, timeoutMs: TIMEOUT_MS,
        });
        if (/NOT ENOUGH EVIDENCE/i.test(raw)) {
          body = '';
        } else {
          const checked = checkCitations(raw, allowed);
          body = checked.text; cited = checked.cited; generated = true;
        }
      } catch (e) { errors.push(`coel: ${e.message}`); }
    }
    if (!body) {
      body = `We have not yet recorded enough about how ${name} approaches their learning — how they explore, ` +
             `stick at things, and come up with their own ideas — to describe it here honestly. Their key person can talk you ` +
             `through what they have noticed day to day.`;
    }
    sections.push({
      key: 'coel', heading: `How ${name} learns`, body, generated,
      evidence: cited,
      note: 'Characteristics of Effective Learning — how the child learns, not a judgement of what they can do.',
    });
  }

  // 4 — the targeted plan. Pre-filled from real open next steps and planned
  // activities so the keyperson edits rather than writes from nothing. Left
  // deliberately unmodelled: what the setting will DO is a professional
  // commitment, agreed with the parents, not something a model gets to promise.
  const openSteps = [];
  for (const k of PRIME_KEYS) {
    for (const n of ev.areas[k].next_steps) if (n.status === 'pending') openSteps.push({ ...n, area: k });
  }
  const planLines = [];
  if (concerns.length) {
    const names = concerns.map(k => PRIME_AREAS.find(a => a.key === k).heading.toLowerCase());
    planLines.push(`The draft flags ${names.join(' and ')} as area${names.length > 1 ? 's' : ''} where progress may be less than expected. ` +
      `The EYFS requires a targeted plan here, agreed with you, and with our SENCO or another professional where that would help. ` +
      `Please add what we have agreed before sending this.`);
  }
  if (openSteps.length) {
    planLines.push('What we are already working on with ' + name + ':');
    for (const n of openSteps.slice(0, 8)) planLines.push('• ' + n.description + ` [${n.ref}]`);
  }
  if (!planLines.length) {
    planLines.push(`There are no open next steps recorded for ${name} at the moment. ${ev.keyperson ? ev.keyperson.name : 'The key person'} ` +
      `will add what we plan to focus on next before this is sent.`);
  }
  sections.push({
    key: 'targeted_plan', heading: 'What we will do next', generated: false,
    body: planLines.join('\n'),
    evidence: openSteps.slice(0, 8).map(n => n.ref),
    needs_plan: concerns.length > 0,
    // Only a plan with nothing real in it is a placeholder. Once there are open
    // next steps to list, or a flagged area, it says something and prints.
    placeholder: !openSteps.length && !concerns.length,
  });

  sections.push({
    key: 'at_home', heading: 'How you can help at home', generated: false,
    // placeholder: prompts the key person, and is DROPPED from the printed copy
    // unless they write something. A parent should never receive a document that
    // says "your key person will add..." — either there is advice or there is no
    // section. printableSections() enforces that.
    placeholder: true,
    body: `Your key person will add one or two simple things you could try at home. If you would like ideas for a particular area, ` +
          `just ask — and please tell us anything you have noticed at home, because that is part of the picture too.`,
  });

  return {
    kind: 'two_year_check',
    version: 1,
    status_note: 'Draft — not yet reviewed by a practitioner.',
    child: ev.child,
    keyperson: ev.keyperson,
    window: ev.window,
    appointment_date: opts.appointment_date || null,
    sections,
    concerns,
    evidence_index: ev.index,
    counts: ev.counts,
    model: {
      host: host || null, model: host ? model : null,
      generated_at: new Date().toISOString(),
      errors: errors.length ? errors : null,
      note: host
        ? 'Drafted on the setting\'s own hardware. No child data left the local network.'
        : 'The local model was unavailable — sections are for the key person to write.',
    },
  };
}

function evidenceRefs(area) {
  return [
    ...area.observations.map(o => o.ref),
    ...area.tracker.filter(t => t.status && t.status !== 'not_yet').map(t => t.ref),
    ...area.next_steps.map(n => n.ref),
  ].slice(0, 20);
}

/** staff.role is a snake_case key; parents should see words. */
function roleLabel(role) {
  return String(role || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Sending ──────────────────────────────────────────────────────────────────
/**
 * The parent-facing sections, in order, for the PDF. Everything the keyperson
 * uses to work (evidence refs, sufficiency counts, invalid citations) is stripped
 * here — a parent gets prose, not our working.
 *
 * Citations are removed from the printed text too: [OBS-412] means nothing to a
 * health visitor, and the traceability that matters lives on the report row.
 */
function printableSections(content) {
  const secs = Array.isArray(content && content.sections) ? content.sections : [];
  const out = secs
    .filter(s => s && String(s.body || '').trim())
    .filter(s => !(s.placeholder && !s.edited_by_practitioner))
    .map(s => ({
      heading: s.heading || null,
      body: String(s.body).replace(REF_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:])/g, '$1').trim(),
    }));

  const signed = content && content.keyperson_signed;
  if (signed && String(signed.name || '').trim()) {
    const sentAt = (content.sent && content.sent.at) || new Date();
    out.push({
      heading: 'Written by',
      body: [
        `${signed.name}${signed.role ? ', ' + signed.role : ''}`,
        longDate(sentAt),
        '',
        'This is the statutory EYFS progress check at age two. Please share it with your health visitor.',
      ].join('\n'),
    });
  }
  return out;
}

module.exports = {
  PRIME_AREAS, PRIME_KEYS, AGE_MIN_MONTHS, AGE_MAX_MONTHS, EVIDENCE_MONTHS,
  DUE_MONTHS, dueDate,   // b244 — 30 months, when it is EXPECTED (vs 24, when it MAY be written)
  // b528 — 18 months, when a PARENT may ask (see requestStage)
  REQUEST_MIN_MONTHS, DRAFT_LEAD_DAYS, requestStage, draftDueNow, resolveCheckRoom, addMonths,
  editionFamily, isEyfsEdition,
  ageInMonths, ymd, longDate, eligibility, roleLabel,
  primeAreaKey, primeAreasOfObservation,
  gatherEvidence, areaSufficiency, buildDraft, printableSections,
  checkCitations, splitConcern,
};
