'use strict';
/**
 * inbox-sections.js — b364 (2026-09-29)
 *
 * Which section an email belongs to. Toby, 2026-09-28: "I'd like to view in
 * sections based on who it's addressed to, or what it's about, i.e. all the
 * parent emails, all the Ealing team emails, all the apprenticeship emails."
 *
 * ── FOUR STEPS, CHEAPEST AND MOST CERTAIN FIRST ─────────────────────────────
 * The brief sets the order and it is the right one:
 *
 *   1. SENDER DOMAIN RULES  (inbox_section_rules)   — ealing.gov.uk is Ealing.
 *      That is not a judgement and no model should be asked. 34 rows are seeded
 *      by the migration and a manager can add, disable or override any of them.
 *
 *   2. DO WE ALREADY KNOW THE SENDER?               — a parent of a child on the
 *      roll, an open enquirer, a member of staff, a supplier in the register.
 *      Also not a judgement: it is a join. This step is why a parent writing
 *      from gmail lands in Parents, which no domain rule could ever achieve.
 *
 *   3. THE b279 ROUTING RULES' TOPIC                — if a rule the manager wrote
 *      has already decided this message's `topic`, that decision is respected
 *      rather than second-guessed. Mapped by TOPIC_TO_SECTION below.
 *
 *   4. THE SMALL LOCAL MODEL                        — last, and only for mail
 *      from a stranger about something we cannot look up.
 *
 * Nothing falls through to "parents". A message that survives all four steps is
 * filed under `other` at confidence 0.2 with source 'fallback', and the screen
 * says so, because a wrong section that looks certain is worse than an honest
 * "I don't know".
 *
 * ── LOCAL MODELS ONLY ───────────────────────────────────────────────────────
 * Step 4 goes through src/lib/sovereign-model.js, whose host parser refuses any
 * address that is not private / Tailscale / loopback. There is no cloud client in
 * this module and no API key read anywhere in it. If the Ascent is unreachable,
 * step 4 is skipped and the message keeps whatever steps 1–3 decided — which is
 * exactly the brief's requirement that "Ascent unreachable → emails still land
 * and sections still work from rules".
 *
 * ── WHAT IS SENT TO THE MODEL ───────────────────────────────────────────────
 * Sender domain, subject, and the first 600 characters of the body, on the
 * nursery's own hardware. Never a child's name from our records (the prompt is
 * built from the email, not from ladn.children) and never anything from a
 * different email.
 */

const sovereign = require('./sovereign-model');

/** The eight sections, matching the inbox_sections rows the migration seeds. */
const SECTIONS = Object.freeze([
  'parents', 'ealing', 'finance', 'admissions', 'apprenticeships', 'suppliers', 'staff', 'other',
]);

/** b279/b338 topic folders → a b364 section. A topic with no mapping falls through. */
const TOPIC_TO_SECTION = Object.freeze({
  new_enquiry:     'admissions',
  ealing:          'ealing',
  bills:           'finance',
  utilities:       'suppliers',
  apprenticeships: 'apprenticeships',
  cpd:             'apprenticeships',
  ofsted:          'other',   // see the migration's note: the regulator has no section yet
  curriculum:      'other',
  // 'general' is deliberately absent — it means "no rule decided", which must
  // not be mistaken for a decision.
});

const CONF = Object.freeze({
  domain: 0.99, contact: 0.97, rule: 0.90, model: 0.60, fallback: 0.20,
});

// ── step 1: the sender rules ────────────────────────────────────────────────

let _rulesCache = { at: 0, rows: null };
const RULES_TTL_MS = 60 * 1000;

async function loadRules(db, { fresh = false } = {}) {
  if (!fresh && _rulesCache.rows && Date.now() - _rulesCache.at < RULES_TTL_MS) return _rulesCache.rows;
  try {
    const { rows } = await db.query(
      `SELECT id, match_kind, value, section, priority, note, seeded
         FROM inbox_section_rules WHERE enabled = true ORDER BY priority ASC, id ASC`);
    _rulesCache = { at: Date.now(), rows };
    return rows;
  } catch (e) {
    // No table yet (a schema without the b364 migration) — steps 2–4 still work.
    _rulesCache = { at: Date.now(), rows: [] };
    return [];
  }
}

function invalidateRules() { _rulesCache = { at: 0, rows: null }; }

function domainMatches(fromEmail, value) {
  const e = String(fromEmail || '').toLowerCase();
  const v = String(value || '').toLowerCase().replace(/^@+/, '');
  if (!e || !v) return false;
  const at = e.lastIndexOf('@');
  if (at < 0) return false;
  const host = e.slice(at + 1);
  return host === v || host.endsWith('.' + v);
}

/** @returns {{section,source,confidence,reason}|null} */
function matchRules(rules, msg) {
  const from = String(msg.fromEmail || '').toLowerCase();
  const fromLine = `${msg.fromName || ''} <${from}>`.toLowerCase();
  const subject = String(msg.subject || '').toLowerCase();
  for (const r of rules) {
    const v = String(r.value || '').toLowerCase();
    let hit = false;
    if (r.match_kind === 'domain')             hit = domainMatches(from, v);
    else if (r.match_kind === 'email')         hit = from === v.replace(/^@+/, '');
    else if (r.match_kind === 'from_contains') hit = !!v && fromLine.includes(v);
    else if (r.match_kind === 'subject')       hit = !!v && subject.includes(v);
    if (hit) {
      return {
        section: r.section,
        source: 'domain',
        confidence: CONF.domain,
        reason: `${r.match_kind === 'domain' ? 'Sender domain' : r.match_kind === 'email' ? 'Sender address'
                  : r.match_kind === 'subject' ? 'Subject' : 'From line'} matches the rule “${r.value}”.`,
        rule_id: r.id,
      };
    }
  }
  return null;
}

// ── step 2: do we already know this sender? ─────────────────────────────────

/**
 * One query, five sources, most specific first. Returns the section AND the ids
 * it found, which src/lib/inbox-hermes.js then uses to build the facts — so the
 * lookup that decides the section is the same lookup that grounds the context,
 * and the two can never disagree.
 *
 * GDPR: ids and a role word come back. No name, no address, no child detail.
 */
async function knownSender(db, fromEmail) {
  const e = String(fromEmail || '').toLowerCase().trim();
  if (!e || e.indexOf('@') < 0) return null;
  try {
    const { rows } = await db.query(`
      WITH hits AS (
        SELECT 'parent'::text AS kind, 1 AS rank, c.id AS ref_id, NULL::int AS alt_id
          FROM children c
         WHERE (c.is_active = true OR c.start_date > CURRENT_DATE)
           AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)
           AND (lower(c.parent_1_email) = $1 OR lower(c.parent_2_email) = $1
                OR lower(c.primary_contact_email) = $1)
        UNION ALL
        SELECT 'bill_payer', 2, i.child_id, NULL::int
          FROM invoices i WHERE lower(i.bill_payer_email) = $1 AND i.child_id IS NOT NULL
        UNION ALL
        SELECT 'staff', 3, s.id, NULL::int
          FROM staff s WHERE s.is_active = true AND lower(s.email) = $1
        UNION ALL
        SELECT 'enquirer', 4, e2.id, NULL::int
          FROM enquiries e2 WHERE lower(e2.parent_email) = $1
        UNION ALL
        SELECT 'supplier', 5, sup.id, NULL::int
          FROM suppliers sup WHERE lower(sup.email) = $1
      )
      SELECT kind, rank, ref_id FROM hits ORDER BY rank ASC, ref_id ASC LIMIT 1`, [e]);
    if (!rows.length) return null;
    const hit = rows[0];
    const map = {
      parent:     { section: 'parents',    what: 'a parent of a child on the roll' },
      bill_payer: { section: 'parents',    what: 'the bill payer on an invoice' },
      staff:      { section: 'staff',      what: 'a member of staff' },
      enquirer:   { section: 'admissions', what: 'an enquiry on file' },
      supplier:   { section: 'suppliers',  what: 'a supplier in the register' },
    }[hit.kind];
    return {
      section: map.section,
      source: 'contact',
      confidence: CONF.contact,
      reason: `The sender's address is on file as ${map.what}.`,
      known_kind: hit.kind,
      known_ref: hit.ref_id,
    };
  } catch (e2) {
    return null;
  }
}

// ── step 4: the small local model ───────────────────────────────────────────

function sectionPrompt(msg) {
  const from = String(msg.fromEmail || '');
  const domain = from.includes('@') ? from.slice(from.lastIndexOf('@') + 1) : '(unknown)';
  const body = String(msg.bodyText || msg.snippet || '').replace(/\s+/g, ' ').slice(0, 600);
  return `An email arrived at Your Nursery, a small nursery in Ealing, West London. Decide which ONE section of the manager's inbox it belongs in.

Sections:
- parents — a family whose child already attends the nursery
- ealing — Ealing Council or a borough team (funding, early years, family information service)
- finance — HMRC, the bank, a card or direct-debit provider, the accountant, payroll
- admissions — a family enquiring about a place, a viewing request, a waiting-list question
- apprenticeships — a training provider, college, awarding body or the apprenticeship service
- suppliers — anyone the nursery buys from: food, utilities, resources, maintenance, insurance
- staff — a member of the team, or recruitment
- other — none of the above

Sender domain: ${domain}
Subject: ${String(msg.subject || '(no subject)').slice(0, 200)}
Body (start): ${body}

Reply with a single JSON object and nothing else:
{"section":"one of the keys above","confidence":0.0,"why":"one short sentence"}`;
}

/** @returns {{section,source,confidence,reason}|null} — null when the model cannot answer. */
async function modelSection(msg) {
  try {
    const out = await sovereign.generateJSON({
      prompt: sectionPrompt(msg),
      // 'fast' — this is a one-word classification, not an essay. The role, not a
      // model name, so a settings row can move it (src/lib/ai-models.js).
      model: require('./ai-models').model('fast'),
      temperature: 0,
      numPredict: 120,
      timeoutMs: parseInt(process.env.B364_CLASSIFY_TIMEOUT_MS || '45000', 10),
    });
    if (!out.ok) return null;
    const v = out.value || {};
    const section = SECTIONS.includes(String(v.section)) ? String(v.section) : null;
    if (!section) return null;
    let conf = Number(v.confidence);
    if (!Number.isFinite(conf) || conf <= 0 || conf > 1) conf = CONF.model;
    // A model's own confidence is capped: it is never allowed to look as certain
    // as a domain rule or a join, however sure it says it is.
    conf = Math.min(conf, 0.85);
    return {
      section,
      source: 'model',
      confidence: conf,
      reason: String(v.why || 'Classified by the local model from the sender and subject.').slice(0, 300),
    };
  } catch (e) {
    // Includes the unreachable/refused-host case. Swallowed on purpose: the
    // caller's contract is "sections still work from rules when the Ascent is
    // down", so a model failure is not an error, it is a skipped step.
    return null;
  }
}

// ── the classifier ──────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} msg          { fromEmail, fromName, subject, bodyText|snippet, topic? }
 * @param {object} [opts]
 * @param {boolean} [opts.useModel=true]
 * @returns {Promise<{section,source,confidence,reason,known_kind?,known_ref?,rule_id?,steps:string[]}>}
 */
async function classify(db, msg, opts = {}) {
  const steps = [];
  const rules = await loadRules(db, { fresh: opts.freshRules === true });

  const byRule = matchRules(rules, msg);
  steps.push(`rules:${byRule ? byRule.section : 'no-match'}`);
  if (byRule) return Object.assign(byRule, { steps });

  const byContact = await knownSender(db, msg.fromEmail);
  steps.push(`contact:${byContact ? byContact.known_kind : 'unknown'}`);
  if (byContact) return Object.assign(byContact, { steps });

  const topic = msg.topic && TOPIC_TO_SECTION[msg.topic] ? TOPIC_TO_SECTION[msg.topic] : null;
  steps.push(`topic:${msg.topic || 'none'}${topic ? '→' + topic : ''}`);
  if (topic) {
    return {
      section: topic, source: 'rule', confidence: CONF.rule,
      reason: `A routing rule had already filed this under “${msg.topic}”.`, steps,
    };
  }

  if (opts.useModel !== false) {
    const byModel = await modelSection(msg);
    steps.push(`model:${byModel ? byModel.section : 'unavailable'}`);
    if (byModel) return Object.assign(byModel, { steps });
  } else {
    steps.push('model:skipped');
  }

  return {
    section: 'other', source: 'fallback', confidence: CONF.fallback,
    reason: 'Nothing on file matched the sender and the local model could not classify it.',
    steps,
  };
}

/**
 * Classify one queue row and write the answer back. Returns the verdict.
 * The UPDATE touches only the six b364 section columns, never `topic` — b279's
 * rules own that column and overwriting it here would fight them.
 */
async function classifyRow(db, row, opts = {}) {
  const verdict = await classify(db, {
    fromEmail: row.from_email, fromName: row.from_name, subject: row.subject,
    bodyText: row.body_text, snippet: row.snippet, topic: row.topic,
  }, opts);
  // review 2026-10-13: opts.skipFallbackWrite — a 'fallback' verdict means "nothing matched and
  // the model did not (or could not) answer", which is not a classification. Writing it turns a
  // NULL row into section='other'/source='fallback', which the EY list treats as classified-
  // but-hidden and the background sweep (WHERE section IS NULL) never revisits. Callers that
  // run without the model, or that may find it down, pass this so the row stays NULL and retryable.
  if (opts.skipFallbackWrite && verdict.source === 'fallback') return verdict;
  await db.query(
    `UPDATE comms_email_queue
        SET section = $2, section_confidence = $3, section_source = $4,
            section_reason = $5, section_set_at = now()
      WHERE id = $1`,
    [row.id, verdict.section, verdict.confidence, verdict.source, verdict.reason.slice(0, 500)]);
  return verdict;
}

/** The section rows, for a switcher that never hard-codes the eight. */
async function sectionList(db) {
  try {
    const { rows } = await db.query(
      `SELECT key, label, description, sort_order, urgent_default
         FROM inbox_sections WHERE archived_at IS NULL ORDER BY sort_order, key`);
    return rows;
  } catch { return SECTIONS.map(k => ({ key: k, label: k, sort_order: 100 })); }
}

/** The sections a manager has asked to be alerted about. */
async function urgentSections(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='inbox_urgent_sections'`);
    if (rows.length) {
      const parsed = JSON.parse(rows[0].value);
      if (Array.isArray(parsed)) return parsed.filter(s => SECTIONS.includes(s));
    }
  } catch (_) {}
  // Fall back to the table's own defaults rather than a literal, so the two
  // cannot drift.
  try {
    const { rows } = await db.query(
      `SELECT key FROM inbox_sections WHERE urgent_default = true AND archived_at IS NULL`);
    if (rows.length) return rows.map(r => r.key);
  } catch (_) {}
  return ['parents', 'ealing', 'finance'];
}

module.exports = {
  SECTIONS, TOPIC_TO_SECTION, CONF,
  loadRules, invalidateRules, domainMatches, matchRules, knownSender, modelSection,
  classify, classifyRow, sectionList, urgentSections,
};
