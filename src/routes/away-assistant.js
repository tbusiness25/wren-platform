'use strict';
/**
 * away-assistant.js — b512 (2026-10-18) the "when Toby's away" assistant.
 *
 *   GET  /api/away-assistant/modes     the five consultant modes + their boundaries
 *   GET  /api/away-assistant/status    corpus counts, model, retrieval health, away-mode banner
 *   POST /api/away-assistant/ask       ask a question in a mode (streams plain text)
 *   GET  /api/away-assistant/source/:id   one cited passage, to show in place
 *   GET  /api/away-assistant/rights    the decision-rights table (and which rows are drafts)
 *   GET  /api/away-assistant/log       recent questions; ?gaps=1 for the unanswered ones
 *   POST /api/away-assistant/log/:id/clear   mark a gap dealt with (manager only)
 *
 * ── THE ONE RULE THAT IS CODE, NOT A PROMPT ──────────────────────────────────
 * An empty retrieval NEVER reaches the model. If nothing in the corpus covers
 * the question, this route answers "nothing covers this", logs a gap row, and
 * returns — the model is not asked to be careful about it, it is not asked at
 * all. That is the only way "it never invents a policy" is true rather than
 * requested. The same applies to an emergency: emergencyCheck() runs on the raw
 * question before retrieval, and its redirect is fixed text with the numbers
 * from the Bible, composed by nobody.
 *
 * ── WHO MAY USE IT ───────────────────────────────────────────────────────────
 * Managers, deputies and owners by role; office managers by staff id, from
 * ladn.settings 'away_assistant_office_manager_ids' (a JSON array — the same
 * shape as roost_admin_staff_ids). A parent token can never reach it: it is
 * mounted behind authenticate with an audience check, PARENT portals are denied
 * at the top, and the role gate excludes every practitioner role anyway.
 *
 * ── CHILD AND FAMILY DATA ────────────────────────────────────────────────────
 * The corpus holds none (every chunk passed the family-data guard at ingest).
 * The QUESTION may, because a person types what is in front of them, so the
 * question is guarded before it is logged and the prompt tells the model to
 * answer the general question instead.
 *
 * No answer, citation or log row is ever built from a child, parent,
 * observation, diary, medicine or safeguarding row. There is exactly ONE read of
 * a family table in this file and it is the guard itself: buildGuard() loads
 * child and contact NAMES into memory so questionGuard() can recognise one and
 * refuse to store the question text. Nothing it sees is returned, logged or
 * printed, and if it cannot be built the route fails closed and stores no
 * question at all. (An earlier version of this comment said "not one query",
 * which overstated it — corrected in review, chain E2, 19 Oct.)
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { rolesHeldBy } = require('../middleware/auth');
const ai = require('../lib/ai-models');
const modes = require('../lib/away-modes');
const rag = require('../lib/manager-rag');
const howtoKnowledge = require('../lib/ask-wren-knowledge');
const { buildGuard } = require('../lib/reading-room-scan');

const OLLAMA_HOST = () => ai.host();
const CHAT_TIMEOUT_MS = parseInt(process.env.AWAY_ASSISTANT_TIMEOUT_MS || '120000', 10);
const MAX_Q = 1200;

// ── the gate ──────────────────────────────────────────────────────────────────
// Roles that always pass. 'manager' expands to manager + deputy_manager through
// rolesHeldBy; 'admin'/'owner' are the owners. A room leader does NOT pass:
// this answers "what do I do while The manager is away", which is a deputy's and an
// office manager's job, and the HR consultant mode in particular must not be
// readable by someone a disciplinary might concern.
const ALLOWED_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];

let _omCache = { at: 0, ids: [] };
async function officeManagerIds(db) {
  if (Date.now() - _omCache.at < 30000) return _omCache.ids;
  let ids = [];
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'away_assistant_office_manager_ids'`);
    if (rows.length) {
      const v = JSON.parse(rows[0].value || '[]');
      if (Array.isArray(v)) ids = v.map(Number).filter(Number.isInteger);
    }
  } catch (_) { /* a missing or malformed row means nobody extra — fail closed */ }
  _omCache = { at: Date.now(), ids };
  return ids;
}

async function gate(req, res, next) {
  // Parent portals never, whatever the token claims.
  if (req._portal === 'parents' || req._portal === 'learning') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const held = rolesHeldBy(req.user && req.user.role);
  if (held.some(r => ALLOWED_ROLES.includes(r))) return next();
  const ids = await officeManagerIds(getPool());
  if (req.user && ids.includes(Number(req.user.id))) { req._awayOfficeManager = true; return next(); }
  return res.status(403).json({ error: 'This is for managers, the deputy and the office managers.' });
}

const managerOnly = (req, res, next) => {
  const held = rolesHeldBy(req.user && req.user.role);
  if (!held.some(r => ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'].includes(r))) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

async function enabled(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'away_assistant_enabled'`);
    return !rows.length || rows[0].value !== 'false';
  } catch { return true; }
}

// ── the guard over the question ───────────────────────────────────────────────
// Built once per process and refreshed every 10 minutes: it reads the live
// children/contacts tables, which is the one place this route touches a family
// table at all, and it reads NAMES ONLY, in memory, to decide whether to store
// the question text. Nothing it sees is returned, logged or printed.
let _guard = { at: 0, g: null };
async function questionGuard(db) {
  if (_guard.g && Date.now() - _guard.at < 600000) return _guard.g;
  try {
    const g = await buildGuard(sql => db.query(sql));
    _guard = { at: Date.now(), g };
    return g;
  } catch (e) {
    console.warn('[away-assistant] question guard unavailable:', e.message);
    // Fail CLOSED on storage: if the guard cannot be built, no question text is
    // stored at all. A gap row with no text is less useful than one with text,
    // and far better than a child's name in a log table.
    const closed = { check: () => ({ hit: true, reason: 'guard_unavailable' }), size: { names: 0, emails: 0 } };
    _guard = { at: Date.now(), g: closed };
    return closed;
  }
}

// ── decision rights ───────────────────────────────────────────────────────────
/**
 * Which decision-rights rows this question is about, best first.
 *
 * Scored on `match_terms` ONLY — the phrases somebody would actually type for
 * that situation — and NOT on the row's topic prose. The first version scored
 * word overlap against the topic and notes, and the evals caught it routing
 * "a member of staff shouted at a colleague in front of parents" to the LADO,
 * because "member" appears in "An allegation against a member of staff" and one
 * common word was enough to win. See the migration's section 6.
 *
 * A longer matched phrase scores higher than a shorter one, so "out of ratio"
 * beats a bare "ratio", and a multi-word phrase cannot be outvoted by two
 * incidental single words.
 *
 * Exported for scripts/b512-evals.js so the eval scores the real function
 * rather than its own copy of it.
 */
async function decisionRights(db, mode, question) {
  const { rows } = await db.query(
    `SELECT id, topic_key, topic, decided_by, escalate_to, wait_for_toby, urgency, basis, notes, approved,
            coalesce(match_terms, '{}') AS match_terms
       FROM manager_decision_rights WHERE $1 = ANY(modes) ORDER BY id`, [mode]);
  if (!rows.length) return [];
  const q = ' ' + String(question).toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const scored = rows.map(r => {
    let score = 0, hits = 0;
    for (const t of (r.match_terms || [])) {
      const term = String(t).toLowerCase().trim();
      if (!term) continue;
      // Whole-word/phrase containment: 'ratio' must not match 'rationale'.
      if (!new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(q)) continue;
      hits++;
      score += term.split(' ').length * 2 + Math.min(term.length, 24) / 12;
    }
    return { ...r, overlap: hits, score };
  }).filter(r => r.overlap > 0);
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  return scored.slice(0, 3);
}

function rightsBlock(rights) {
  if (!rights.length) return '';
  const lines = rights.map(r => {
    const bits = [`TOPIC: ${r.topic}`, `DECIDED BY: ${r.decided_by}`];
    if (r.escalate_to) bits.push(`THEN: ${r.escalate_to}`);
    if (r.wait_for_toby) bits.push('WAIT FOR TOBY: yes');
    bits.push(`URGENCY: ${r.urgency}`);
    if (r.basis) bits.push(`BASIS: ${r.basis}`);
    if (r.notes) bits.push(`NOTE: ${r.notes}`);
    bits.push(r.approved ? 'STATUS: approved by Toby' : 'STATUS: DRAFT — not yet approved by Toby, say so');
    return bits.join('\n');
  });
  return `\n\nDECISION RIGHTS — use these for the "Who decides:" line. A row marked DRAFT must be described as a draft in that line:\n\n${lines.join('\n\n')}`;
}

// ── GET /modes ────────────────────────────────────────────────────────────────
router.get('/modes', authenticate, gate, (req, res) => {
  res.json({ default: modes.DEFAULT_MODE, modes: modes.publicModes() });
});

// ── GET /status ───────────────────────────────────────────────────────────────
router.get('/status', authenticate, gate, async (req, res) => {
  const db = getPool();
  const out = { enabled: await enabled(db), model: ai.model('heavy'), embed_model: ai.model('embed'),
                collection: rag.COLLECTION, corpus: null, ollama: false, qdrant: false, away: { show: false } };
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS chunks,
              count(*) FILTER (WHERE withheld)::int AS withheld,
              count(DISTINCT doc_key) FILTER (WHERE NOT withheld)::int AS docs,
              count(*) FILTER (WHERE embedded AND NOT withheld)::int AS embedded,
              max(updated_at) AS updated
         FROM manager_corpus`);
    out.corpus = rows[0];
    const { rows: byKind } = await db.query(
      `SELECT source_kind, count(*)::int AS n FROM manager_corpus WHERE NOT withheld GROUP BY 1 ORDER BY 2 DESC`);
    out.corpus.by_kind = byKind;
    const { rows: r } = await db.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE approved)::int AS approved FROM manager_decision_rights`);
    out.decision_rights = r[0];
  } catch (e) {
    if (e.code === '42P01') out.corpus = { chunks: 0, note: 'the b512 migration has not been applied' };
    else out.corpus = { chunks: 0, note: 'corpus unavailable' };
  }
  // Away mode's own banner — the existing /api/away-mode state, not a second one.
  try {
    const { rows } = await db.query(
      `SELECT am.active, am.show_banner, am.return_date, s.first_name AS cover_first,
              s.first_name || ' ' || s.last_name AS cover_name,
              replace(coalesce(s.role,'deputy manager'),'_',' ') AS cover_role
         FROM away_mode am LEFT JOIN staff s ON s.id = am.cover_person_id WHERE am.id = 1`);
    const a = rows[0];
    if (a && a.active) {
      out.away = { show: true, cover_name: a.cover_name || null, cover_first: a.cover_first || null,
        cover_role: a.cover_role || null,
        return_date: a.return_date ? new Date(a.return_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : null };
    }
  } catch (_) {}
  try { const r = await fetch(`${OLLAMA_HOST()}/api/tags`, { signal: AbortSignal.timeout(4000) }); out.ollama = r.ok; } catch {}
  try {
    const r = await fetch(`${process.env.MANAGER_QDRANT_URL || process.env.APPRENTICE_QDRANT_URL || 'http://qdrant-work:6333'}/collections/${rag.COLLECTION}`,
      { signal: AbortSignal.timeout(4000) });
    out.qdrant = r.ok;
  } catch {}
  res.json(out);
});

// ── GET /rights ───────────────────────────────────────────────────────────────
router.get('/rights', authenticate, gate, async (req, res) => {
  const db = getPool();
  try {
    const mode = req.query.mode ? modes.getMode(req.query.mode).key : null;
    const { rows } = await db.query(
      `SELECT id, topic_key, topic, modes, decided_by, escalate_to, wait_for_toby, urgency, basis, notes, approved,
              coalesce(match_terms, '{}') AS match_terms
         FROM manager_decision_rights ${mode ? 'WHERE $1 = ANY(modes)' : ''} ORDER BY
           CASE urgency WHEN 'emergency' THEN 0 WHEN 'today' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, topic`,
      mode ? [mode] : []);
    res.json({ rights: rows, drafts: rows.filter(r => !r.approved).length });
  } catch (e) {
    if (e.code === '42P01') return res.json({ rights: [], drafts: 0, note: 'the b512 migration has not been applied' });
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /source/:id ───────────────────────────────────────────────────────────
// One cited passage, shown in place. NEVER returns a withheld row — the chunk is
// NULL in the table anyway, and this refuses before it looks.
router.get('/source/:id', authenticate, gate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const { rows } = await getPool().query(
      `SELECT id, source_kind, source_label, open_url, title, section_path, content, doc_date, doc_key
         FROM manager_corpus WHERE id = $1 AND NOT withheld AND content IS NOT NULL`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '42P01') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: 'DB error' });
  }
});

// ── GET /log ──────────────────────────────────────────────────────────────────
router.get('/log', authenticate, gate, async (req, res) => {
  const db = getPool();
  const gaps = req.query.gaps === '1' || req.query.gaps === 'true';
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    const { rows } = await db.query(
      `SELECT l.id, l.mode, l.question, l.question_withheld, l.citations, l.decision_owner, l.gap,
              l.gap_cleared_at, l.emergency, l.retrieval_mode, l.created_at, l.portal,
              s.first_name AS asked_by
         FROM assistant_away_log l LEFT JOIN staff s ON s.id = l.staff_id
        ${gaps ? 'WHERE l.gap AND l.gap_cleared_at IS NULL' : ''}
        ORDER BY l.created_at DESC LIMIT $1`, [limit]);
    const { rows: [c] } = await db.query(
      `SELECT count(*)::int AS gaps FROM assistant_away_log WHERE gap AND gap_cleared_at IS NULL`);
    res.json({ entries: rows, open_gaps: c.gaps });
  } catch (e) {
    if (e.code === '42P01') return res.json({ entries: [], open_gaps: 0, note: 'the b512 migration has not been applied' });
    res.status(500).json({ error: 'DB error' });
  }
});

// ── POST /log/:id/clear ───────────────────────────────────────────────────────
router.post('/log/:id/clear', authenticate, managerOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const { rowCount } = await getPool().query(
      `UPDATE assistant_away_log SET gap_cleared_at = now() WHERE id = $1 AND gap AND gap_cleared_at IS NULL`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not an open gap' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ── the model call ────────────────────────────────────────────────────────────
async function ollamaChat(messages, { stream }) {
  return fetch(`${OLLAMA_HOST()}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ai.model('heavy'), messages, stream, think: false,
      options: ai.options({ temperature: 0.15 }, 'long'),
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
}

/** The "Who decides:" line this route writes itself when the model forgets. */
function fallbackOwner(rights) {
  if (!rights.length) return null;
  const r = rights[0];
  const draft = r.approved ? '' : ' (draft — not yet approved by Toby)';
  return r.wait_for_toby
    ? `${r.decided_by} — this one waits for Toby${r.escalate_to ? `; if he cannot be reached: ${r.escalate_to}` : ''}${draft}`
    : `${r.decided_by}${r.escalate_to ? `, then ${r.escalate_to}` : ''}${draft}`;
}

async function logQuestion(db, row) {
  try {
    const { rows } = await db.query(
      `INSERT INTO assistant_away_log
         (staff_id, portal, mode, question, question_withheld, cited_doc_ids, citations, decision_owner,
          gap, emergency, retrieval_mode, model, answer_chars, ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [row.staff_id, row.portal, row.mode, row.question, row.question_withheld, row.cited_doc_ids,
       JSON.stringify(row.citations || []), row.decision_owner, row.gap, row.emergency,
       row.retrieval_mode, row.model, row.answer_chars, row.ms]);
    return rows[0].id;
  } catch (e) {
    if (e.code !== '42P01') console.error('[away-assistant] log failed:', e.message);
    return null;
  }
}

// ── POST /ask ─────────────────────────────────────────────────────────────────
// Streams plain text (chunked), like /api/assistant/chat — not SSE. The meta
// (citations, decision owner, gap flag, mode) comes back in a base64 header,
// because a raw header cannot hold the em-dashes and the section titles.
router.post('/ask', authenticate, gate, async (req, res) => {
  const db = getPool();
  const t0 = Date.now();
  const staffId = req.user && req.user.id;
  const portal = req._portal === 'hr' ? 'hr' : 'admin';
  const modeKey = modes.getMode(req.body && req.body.mode).key;
  const question = String((req.body && req.body.question) || '').trim().slice(0, MAX_Q);
  const wantStream = !(req.body && req.body.stream === false);

  if (!question) return res.status(400).json({ error: 'A question is required' });
  if (!await enabled(db)) return res.status(503).json({ error: 'The away assistant is switched off.' });

  // Guard the question BEFORE anything else stores it.
  const g = await questionGuard(db);
  const qHit = g.check(question);
  const storeQ = qHit.hit ? null : question;

  const meta = { mode: modeKey, citations: [], decision_owner: null, decision_is_draft: false,
                 decision_topic: null, gap: false, emergency: false,
                 retrieval: 'none', model: null, question_withheld: qHit.hit };

  const finish = async (text, extra = {}) => {
    Object.assign(meta, extra);
    meta.log_id = await logQuestion(db, {
      staff_id: staffId, portal, mode: modeKey, question: storeQ, question_withheld: qHit.hit,
      cited_doc_ids: meta.citations.map(c => c.id).filter(Number.isInteger),
      citations: meta.citations, decision_owner: meta.decision_owner, gap: meta.gap,
      emergency: meta.emergency, retrieval_mode: meta.retrieval, model: meta.model,
      answer_chars: text.length, ms: Date.now() - t0,
    });
    if (!wantStream) return res.json({ answer: text, ...meta });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Away-Meta-B64', Buffer.from(JSON.stringify(meta), 'utf8').toString('base64'));
    res.end(text);
  };

  // 1. EMERGENCY — fixed text, the numbers from the Bible, no model, no retrieval.
  //    A DOWNGRADED hit (a fire or police question whose wording says it is over
  //    and asks what to do next) is not blocked: the answer is composed as usual
  //    with a one-line safety note on top. The redirect is softened, never
  //    dropped — see isRetrospective() in away-modes.js for why.
  const em = modes.emergencyCheck(question);
  if (em && !em.downgraded) {
    return finish(em.text, { emergency: true, decision_owner: em.call, retrieval: 'none' });
  }
  const safety = em && em.downgraded ? em.prefix : '';

  // 2. RETRIEVE. An empty retrieval never reaches the model.
  const howtoMode = modes.getMode(modeKey).retrieval === 'howto';
  let r;
  try {
    r = howtoMode ? await howtoRetrieve(db, req, question) : await rag.retrieve(db, question, modeKey, 8);
  } catch (e) {
    console.error('[away-assistant] retrieval failed:', e.message);
    return finish(safety + "I could not reach the document corpus just now, so I am not going to guess. Try again in a moment; if it keeps failing, the corpus may need rebuilding (scripts/b512-manager-corpus-ingest.js).", { retrieval: 'error' });
  }
  const rights = howtoMode ? [] : await decisionRights(db, modeKey, question).catch(() => []);
  // THE DRAFT FLAG IS THE ROUTE'S TO SET, NOT THE MODEL'S TO REMEMBER.
  // The prompt asks the model to say when it is leaning on a draft rule, and the
  // UI check caught it simply not doing so — it wrote a perfectly good
  // "Who decides:" line with no mention that the rule behind it is unapproved.
  // A warning that depends on a 27B remembering an instruction is not a warning,
  // so the fact travels in the meta and the UI renders it from there.
  if (rights.length) {
    meta.decision_is_draft = !rights[0].approved;
    meta.decision_topic = rights[0].topic;
  }

  if (!r.chunks.length && howtoMode) {
    const text = `**Wren's guides don't cover this yet.**\n\n`
      + `I won't guess where a button is. This question has been logged for Toby, so the guide can be written.\n\n`
      + `Meanwhile: press **❓** at the top of any Roost page and choose *Help for this page*, or press **Ctrl + K** to search Wren for the page you want.`;
    return finish(text, { gap: true, retrieval: r.mode });
  }
  if (!r.chunks.length) {
    const owner = fallbackOwner(rights);
    const text = safety + `**Nothing in the Bible or the policies covers this.**\n\n`
      + `I will not guess at a policy, so here is what I actually have:\n\n`
      + (rights.length
          ? `- The decision-rights table does have a related entry — *${rights[0].topic}* — and it says: **${rights[0].decided_by}**${rights[0].notes ? `. ${rights[0].notes}` : ''}${rights[0].approved ? '' : ' *(This is a draft Toby has not approved yet.)*'}\n`
          : '')
      + `- Nothing else written down answers it.\n\n`
      + `**What to do now:** if it can wait, it waits for Toby — and this question has been logged for him, so he will see it on his board when he is back. `
      + `If it cannot wait, make the call that keeps the children safe and the setting open, write down what you did and why, and tell him as soon as you can. `
      + `That is a defensible position; a guess dressed up as a policy is not.\n\n`
      + (owner ? `Who decides: ${owner}\n` : `Who decides: you, on the day, and Toby afterwards.\n`);
    return finish(text, { gap: true, retrieval: r.mode, decision_owner: owner });
  }

  meta.citations = rag.citations(r.chunks);
  meta.retrieval = r.mode;
  if (safety) meta.safety_note = em.kind;
  meta.model = ai.model('heavy');

  // 3. ASK.
  const mode = modes.getMode(modeKey);
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const sys = `${mode.prompt}

Today is ${today}. The setting is Your Nursery, 123 Example Lane, Your Town, AB1 2CD, open Monday to Friday 8am–6pm.
Rooms: Baby Room (6 months–2 years, maximum 10) and Pre-school (2–5 years, maximum 22). Ofsted URN 000000.
Boundaries you must keep, which the person asking can also see on screen:
${mode.boundaries.map(b => `- ${b}`).join('\n')}
${rightsBlock(rights)}${rag.buildGroundingBlock(r.chunks)}`;

  const messages = [{ role: 'system', content: sys }, { role: 'user', content: question }];

  if (!wantStream) {
    let text = safety;
    try {
      const resp = await ollamaChat(messages, { stream: false });
      if (!resp.ok) throw new Error(`ollama ${resp.status}`);
      const j = await resp.json();
      text += (j.message && j.message.content) || '';
    } catch (e) {
      console.error('[away-assistant] ollama failed:', e.message);
      text = safety + modelDownText(r.chunks, rights);
      meta.model = null;
    }
    if (!/who decides:/i.test(text)) {
      const owner = fallbackOwner(rights);
      if (owner) text += `\n\nWho decides: ${owner}`;
    }
    meta.decision_owner = extractOwner(text) || fallbackOwner(rights);
    return finish(text, { gap: howtoMode && HOWTO_UNCOVERED.test(text) });
  }

  // Streaming. The meta header must go out BEFORE the first byte, so the
  // citations are the retrieved labels (which are known now) and never
  // anything the model wrote — same rule as the apprentice chat.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Away-Meta-B64', Buffer.from(JSON.stringify(meta), 'utf8').toString('base64'));

  let text = '';
  if (safety) { text = safety; res.write(safety); }
  try {
    const resp = await ollamaChat(messages, { stream: true });
    if (!resp.ok) throw new Error(`ollama ${resp.status}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const ln of lines) {
        if (!ln.trim()) continue;
        let j; try { j = JSON.parse(ln); } catch { continue; }
        const piece = (j.message && j.message.content) || '';
        if (piece) { text += piece; res.write(piece); }
      }
    }
  } catch (e) {
    console.error('[away-assistant] stream failed:', e.message);
    if (text === safety) { const t = modelDownText(r.chunks, rights); text += t; res.write(t); }
  }
  if (!/who decides:/i.test(text)) {
    const owner = fallbackOwner(rights);
    if (owner) { const tail = `\n\nWho decides: ${owner}`; text += tail; res.write(tail); }
  }
  meta.decision_owner = extractOwner(text) || fallbackOwner(rights);
  // The log row, written after the body — a failed log must never truncate an
  // answer somebody is reading at 6:15pm.
  await logQuestion(db, {
    staff_id: staffId, portal, mode: modeKey, question: storeQ, question_withheld: qHit.hit,
    cited_doc_ids: meta.citations.map(c => c.id).filter(Number.isInteger),
    citations: meta.citations, decision_owner: meta.decision_owner,
    // "Using Wren": passages were found but the model judged they don't answer it.
    // Log that as a gap too, so Toby sees which guide is missing.
    gap: howtoMode && HOWTO_UNCOVERED.test(text),
    emergency: false, retrieval_mode: meta.retrieval, model: meta.model,
    answer_chars: text.length, ms: Date.now() - t0,
  });
  res.end();
});

function extractOwner(text) {
  const m = /who decides:\s*(.+)/i.exec(String(text));
  return m ? m[1].split('\n')[0].trim().slice(0, 300) : null;
}

/**
 * The Ascent is unreachable. Still answer: the passages ARE the answer, they
 * just are not written up. A deputy at 6:15pm would rather read three cited
 * paragraphs than an error.
 */
// ── "Using Wren" mode ────────────────────────────────────────────────────────
// The how-to index and page finder Ask Wren uses (src/lib/ask-wren-knowledge.js),
// asked from the manager's side so Roost's own guides are included. The hits are
// shaped as corpus chunks, so the grounding block, the citations, the gap log and
// the model-down fallback below all work unchanged.
const PORTAL_HOST = { ey: 'ey', hr: 'hr', parents: 'parents' };
const HOWTO_UNCOVERED = /guides don.t cover this/i;   // the mode prompt's own words
/** A page in another app is on another host: link it there, or the link 404s in Roost. */
function pageUrl(req, url, portal) {
  if (!url || !/^\//.test(url)) return null;
  const prefix = PORTAL_HOST[portal];
  if (!prefix) return url;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  const m = /^admin\.(.+)$/.exec(host);
  return m ? `https://${prefix}.${m[1]}${url}` : null;
}
async function howtoRetrieve(db, req, question) {
  const hits = await howtoKnowledge.howto({ portal: 'admin', question, pool: db }, question);
  const chunks = hits.map(h => {
    const open = pageUrl(req, h.url, h.portal);
    return {
      id: null,
      source_kind: h.source === 'in-app guide' || h.source === 'tour' ? 'wren-page' : 'wren-guide',
      source_label: h.title, title: h.title, section_path: null, open_url: open,
      // The path goes INTO the passage: the model may only link a path it has been given.
      text: (open ? `Page: ${open}\n` : '') + h.text,
    };
  });
  return { chunks, mode: chunks.length ? 'howto' : 'none' };
}

function modelDownText(chunks, rights) {
  const owner = fallbackOwner(rights);
  return `**The nursery's own AI model could not be reached**, so this is not a written answer — it is the passages themselves, which is all I will give you rather than making something up.\n\n`
    + chunks.slice(0, 4).map((c, i) =>
        `**${i + 1}. ${c.source_label}${c.section_path ? ` — ${c.section_path}` : ''}**\n\n${String(c.text).slice(0, 900)}`).join('\n\n---\n\n')
    + (owner ? `\n\nWho decides: ${owner}` : '');
}

module.exports = router;
module.exports.decisionRights = decisionRights;   // scripts/b512-evals.js scores the real matcher
module.exports.__test = { decisionRights, fallbackOwner, extractOwner, rightsBlock, officeManagerIds };
