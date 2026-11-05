'use strict';
/**
 * ask-wren-knowledge.js — b527 (2026-10-26). The three knowledge retrievals
 * behind Ask Wren's non-child tools: EYFS, how-to-use-Wren, and our own
 * policies.
 *
 * ── WHICH STORE, AND WHY NOT THE OBVIOUS ONE ─────────────────────────────────
 * The brief said "the wren_brain_v1 vector search (brain.js)". Reading what
 * actually fills that collection changed the answer, and this is the one place
 * this build deliberately departs from the brief:
 *
 *   scripts/wren-brain-ingest.js ingests, into wren_brain_v1:
 *     · wren-docs markdown, CLAUDE.md, LADN-STATE.md       (fine)
 *     · THE DRIVE MIRROR (/data/drive-mirror)         (family data)
 *     · ladn.email_triage summaries, last 12 months        (family data)
 *     · EyLog monthly observation aggregates               (child data)
 *
 * wren_brain_v1 is read today by /api/brain, which is MANAGER-ONLY for exactly
 * that reason (brain.js: `router.use(requireRole('manager'))`). Ask Wren is
 * practitioner- and apprentice-facing. Pointing an apprentice's "what does EYFS
 * say about schemas?" at a store that also holds a year of the nursery's email
 * would be a data leak dressed as a feature, and it would be ungated — a vector
 * search has no row-level permission to inherit, which is the whole reason the
 * child tools go through the API instead.
 *
 * So:
 *   eyfs()   → eyfs_brain_v1 via src/lib/eyfs-brain-rag.js. Purpose-built,
 *              licence-clean, statutory + DfE + Fledge + our own policies, with
 *              a Postgres FTS mirror and a written source registry
 *              (wren-docs/eyfs-brain/corpus-manifest.md). Hybrid retrieval, so
 *              an exact keyword hit cannot be buried by embedding luck.
 *   howto()  → wren_howto_v1 (built by scripts/b527-build-howto-index.js) PLUS
 *              brain.js's own _whereIs(), which is a DETERMINISTIC match over
 *              public/js/wren-tour-content.js and therefore cannot be wrong
 *              about which page a feature is on. The deterministic half is
 *              consulted first and always; the vector half catches phrasings it
 *              misses. _whereIs's vector leg is scoped to source in
 *              (tour|help|guide), so it never returns a drive-mirror or email
 *              chunk even though it reads wren_brain_v1.
 *   policies() → the real GET /api/policies, through the loopback, so a
 *              practitioner sees the policies required of their role and a
 *              manager sees all of them, exactly as the Policies page shows.
 *
 * Nothing in here embeds or stores the person's question.
 */

const ai = require('./ai-models');
const { callAsUser } = require('./wren-loopback');

const QDRANT_URL = process.env.HOWTO_QDRANT_URL || process.env.BRAIN_QDRANT_URL || 'http://qdrant-work:6333';
const HOWTO_COLLECTION = process.env.HOWTO_COLLECTION || 'wren_howto_v1';
// The manager view's slice of wren_howto_v1 — every portal a manager can open.
const MANAGER_PORTALS = ['roost', 'ey', 'hr', 'parents', 'any'];
/** nomic-embed-text's cosine baseline is noisy (~0.5 for unrelated text) — same floor as the siblings. */
const HOWTO_FLOOR = parseFloat(process.env.HOWTO_SCORE_FLOOR || '0.55');
const EMBED_TIMEOUT_MS = 8000;
const SEARCH_TIMEOUT_MS = 6000;

// ── EYFS ────────────────────────────────────────────────────────────────────
/**
 * @returns {Promise<Array<{source:string,url:string|null,text:string}>>}
 *          Each hit carries the DOCUMENT TITLE, because an EYFS answer without
 *          its source is not an answer the person can check.
 */
async function eyfs(ctx, topic) {
  const q = String(topic || '').trim();
  if (q.length < 3) return [];
  const out = [];

  // 1. The purpose-built corpus. Hybrid (qdrant + Postgres FTS + quick facts).
  //
  //    TWO QUERIES, NOT ONE, AND THIS IS LOAD-BEARING. eyfs-brain-rag's
  //    confidence gate declines rather than grounding on noise, and a ONE-WORD
  //    topic trips it: measured on wren_dev, "schemas" returns mode 'none' and
  //    nothing, while "schema play repeated patterns" returns five chunks. The
  //    model, asked for a `topic`, naturally passes the one word — so the first
  //    run of this build answered "nothing covers schemas" about a corpus that
  //    has a chapter on them. So if the terse topic declines, the PERSON'S WHOLE
  //    QUESTION is tried, which carries the lexical overlap the gate wants.
  try {
    const rag = require('./eyfs-brain-rag');
    // retrieve() returns {chunks, mode} and deliberately answers {chunks:[]} when
    // its own confidence gate is not met. An empty result is a real answer, not
    // a failure.
    let r = await rag.retrieve(ctx.pool, q, 5);
    const whole = String(ctx.question || '').trim();
    if (!(r.chunks || []).length && whole && whole.toLowerCase() !== q.toLowerCase()) {
      r = await rag.retrieve(ctx.pool, whole, 5);
    }
    for (const c of (r.chunks || [])) {
      out.push({
        source: c.source_label || 'EYFS corpus',
        url: c.source_url || null,
        text: String(c.text || '').slice(0, 1800),
      });
    }
  } catch (e) {
    console.warn('[ask-wren] eyfs_brain retrieval unavailable:', e.message);
  }

  // 2. The statutory corpus by full-text search, through the real endpoint so
  //    its own isStaff() gate applies and the OGL attribution comes with it.
  if (out.length < 4) {
    try {
      const res = await callAsUser(ctx.req, {
        path: '/api/gov-corpus/rag-context', query: { topic: q, max_chunks: 4 },
      });
      if (res.status === 200 && res.json && Array.isArray(res.json.chunks)) {
        for (const c of res.json.chunks) {
          out.push({
            source: [c.document_title, c.version_date ? String(c.version_date).slice(0, 10) : null]
              .filter(Boolean).join(', '),
            url: c.source_url || null,
            text: String(c.chunk_text || '').slice(0, 1800),
          });
        }
      }
    } catch (e) {
      console.warn('[ask-wren] gov-corpus unavailable:', e.message);
    }
  }

  // De-duplicate by source + first 80 characters.
  const seen = new Set();
  return out.filter((h) => {
    const k = h.source + '|' + h.text.slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);
}

// ── how to use Wren ─────────────────────────────────────────────────────────
async function embed(text) {
  const resp = await fetch(`${ai.host()}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.model('embed'), prompt: String(text).slice(0, 4000) }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`embed ${resp.status}`);
  const j = await resp.json();
  if (!Array.isArray(j.embedding)) throw new Error('no embedding');
  return j.embedding;
}

/** Vector search over wren_howto_v1, scoped to the portal the person is on. */
async function howtoVector(portal, question, k = 6) {
  const vector = await embed(question);
  const body = {
    vector, limit: k, with_payload: true,
    // A payload filter, not a post-filter: an EY practitioner asking "where do I
    // book holiday" should get the HR page, so 'any' includes the shared rows.
    // 'admin' is the manager view (the "Using Wren" mode of the away assistant,
    // manager-only): Roost's own guides plus every app a manager can open. The
    // Roost and parents rows are tagged 'roost'/'parents', so the tablets and the
    // HR app, which ask for [ey|hr, any], never see them.
    filter: { must: [{ key: 'portals', match: { any: portal === 'admin' ? MANAGER_PORTALS : [portal, 'any'] } }] },
  };
  const resp = await fetch(`${QDRANT_URL}/collections/${HOWTO_COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`qdrant ${resp.status}`);
  const j = await resp.json();
  return (j.result || [])
    .filter((p) => p.score >= HOWTO_FLOOR)
    .map((p) => ({
      match: 'vector',
      title: (p.payload && p.payload.title) || 'Wren',
      url: (p.payload && p.payload.url) || null,
      portal: (p.payload && Array.isArray(p.payload.portals) && p.payload.portals[0] !== 'any' && p.payload.portals[0]) || null,
      source: (p.payload && p.payload.source) || 'guide',
      text: String((p.payload && p.payload.text) || '').slice(0, 1200),
      score: p.score,
    }));
}

/**
 * @returns {Promise<Array<{title:string,url:string|null,text:string,match:string}>>}
 *          Deterministic corpus matches first — they cannot be wrong about which
 *          page a thing is on — then the vector hits.
 */
async function howto(ctx, task) {
  const q = String(task || '').trim();
  if (q.length < 3) return [];
  // The person's own words are the better query for the deterministic matcher
  // when the model has boiled the task down to one or two — same reason as the
  // eyfs() retry above.
  const whole = String(ctx.question || '').trim();
  const portal = ctx.portal === 'hr' ? 'hr' : ctx.portal === 'admin' ? 'admin' : 'ey';
  const out = [];

  // 1. The deterministic page corpus, through brain.js's own _whereIs (so there
  //    is one matcher, not a second copy of it).
  //
  //    ASK FOR MANY, THEN FILTER BY PORTAL — not the other way round. The
  //    corpus covers all four portals and its scorer is word-overlap, so a
  //    practitioner's "record a nappy change" is won outright by Roost's CPD
  //    *records* and data-governance *records*-map pages on the word "record".
  //    Filtering a top-5 then left nothing at all, which is how this build's
  //    first run answered "I have nothing written down" about a page that
  //    exists (/ey/group/nappies.html). Taking 3x and filtering after fixes it.
  //
  //    Roost and the parents app are dropped: a practitioner cannot open them.
  //    The OTHER staff app is kept and labelled, because staff do use both —
  //    "where do I book holiday" asked on a tablet should answer with the HR app.
  const STAFF_PORTALS = portal === 'admin'
    ? { roost: 'Roost', ey: 'Nest, the EY app', hr: 'Seed, the HR app', parents: "Finch, the parents' app" }
    : { ey: 'the EY app', hr: 'the HR app' };
  const HOME = portal === 'admin' ? 'roost' : portal;
  try {
    const brain = require('../routes/brain');
    let where = await brain._whereIs(q, 15);
    if (!(where.results || []).length && whole && whole.toLowerCase() !== q.toLowerCase()) {
      where = await brain._whereIs(whole, 15);
    }
    for (const r of (where.results || [])) {
      if (!r.url) continue;
      if (r.portal && !STAFF_PORTALS[r.portal]) continue;
      out.push({
        match: r.match,
        title: r.portal && r.portal !== HOME ? `${r.title} — in ${STAFF_PORTALS[r.portal]}` : r.title,
        url: r.url, portal: r.portal || null, source: 'in-app guide',
        text: [r.what, r.does, r.gotcha ? `Watch out: ${r.gotcha}` : null,
               r.status && r.status !== 'ok' ? `KNOWN ISSUE: ${r.issue || r.status}` : null]
          .filter(Boolean).join(' ').slice(0, 1200),
      });
      if (out.length >= 4) break;
    }
  } catch (e) {
    console.warn('[ask-wren] whereIs unavailable:', e.message);
  }

  // 2. The b527 index: the staff manuals, the help pages, the staff guide and
  //    the What's new entries.
  try {
    const hits = await howtoVector(portal, q, portal === 'admin' ? 8 : 6);
    if (portal === 'admin') {
      // The manager view INTERLEAVES the two halves. Across all four apps the page
      // matcher's word overlap fills its four slots with near-misses ("send a family
      // the registration form" scored Staff → Performance, Family and Nest's email
      // page level at the top), which pushed the admissions guide that answers it
      // off the end. Alternating keeps both, and the tablets' order is unchanged.
      const det = out.splice(0);
      const seen = new Set();
      for (let i = 0; i < Math.max(det.length, hits.length); i++) {
        for (const h of [hits[i], det[i]]) {
          if (!h) continue;
          const key = `${h.url || ''}|${String(h.text || '').slice(0, 80)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(h);
        }
      }
    } else {
      const seen = new Set(out.map((o) => o.url));
      for (const h of hits) {
        if (h.url && seen.has(h.url)) continue;
        out.push(h);
      }
    }
  } catch (e) {
    // Best-effort: the deterministic half still answers "which page" when
    // Ollama or qdrant is down, which is the point of having both.
    console.warn('[ask-wren] howto index unavailable:', e.message);
  }

  // fledge-off (2026-10-26): while Fledge is off its pages 404 and staff are never
  // told about it, so a guide or tour stop that names it is dropped here — the same
  // rule eyfs-brain-rag.js applies to the EYFS corpus.
  let kept = out;
  try {
    if (!(await require('./fledge-switch').isFledgeEnabled(ctx.pool))) {
      kept = out.filter((h) => !/fledge/i.test(`${h.title || ''} ${h.url || ''} ${h.text || ''}`));
    }
  } catch (e) {
    kept = out.filter((h) => !/fledge/i.test(`${h.title || ''} ${h.url || ''} ${h.text || ''}`));
  }

  return kept.slice(0, portal === 'admin' ? 8 : 6);
}

// ── our own policies ────────────────────────────────────────────────────────
const STOP = new Set(['what', 'does', 'our', 'the', 'policy', 'policies', 'say', 'says', 'about',
  'how', 'and', 'for', 'with', 'that', 'this', 'when', 'where', 'which', 'is', 'are', 'was', 'can',
  'could', 'should', 'do', 'does', 'did', 'we', 'you', 'a', 'an', 'of', 'in', 'to', 'on', 'it',
  'at', 'if', 'i', 'my', 'me', 'wren',
  // App VERBS, not policy topics. "record" is the one that mattered: it is a
  // substring of "recording", so "how do I record a nappy change" scored the
  // CCTV policy ("...CCTV recording...") as the best match and the answer came
  // back citing it. A citation that is confidently wrong is worse than none.
  'record', 'records', 'recording', 'log', 'logged', 'add', 'added', 'find', 'use', 'using',
  'enter', 'write', 'written', 'open', 'click', 'tap', 'page', 'screen', 'button']);

function keywords(q) {
  return String(q || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/)
    // Length > 2, not > 3: "sun" (sun cream), "gas", "ill", "pay" are all real
    // policy topics, and raising the floor to 4 silently dropped "sun" from
    // "what does our sun cream policy say".
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Whole-word containment. 'ratio' must not match 'rationale', 'record' must not match 'recording'. */
function wordIn(hay, word) {
  return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(hay);
}

/**
 * Our own policies, through the real endpoint. Returns an ask-wren-tools result
 * object (ok/empty/refused) because the whole tool is this one function.
 */
async function policies(ctx, topic) {
  const tools = require('./ask-wren-tools');
  const words = keywords(topic);
  const res = await callAsUser(ctx.req, { path: '/api/policies' });
  if (res.status !== 200) {
    return tools.fromResponse(res, () => tools.empty());
  }
  const all = Array.isArray(res.json) ? res.json : tools.rowsOf(res.json);
  if (!all.length) {
    return tools.empty('There are no policies on Wren that apply to your role.');
  }
  // Weighted by WHERE the word was found, on whole words only, and with a floor.
  // The title is what a policy is about; a summary mentioning a word in passing
  // is not a match worth citing. MIN_SCORE ~= one solid word in the title.
  const MIN_SCORE = 9;
  const scored = all.map((p) => {
    let score = 0;
    for (const w of words) {
      if (wordIn(String(p.title || ''), w)) score += 3 * Math.min(w.length, 12);
      else if (wordIn(String(p.category || ''), w)) score += 2 * Math.min(w.length, 12);
      else if (wordIn(String(p.summary || ''), w)) score += Math.min(w.length, 12);
    }
    return { p, score };
  }).filter((x) => x.score >= MIN_SCORE).sort((a, b) => b.score - a.score || a.p.id - b.p.id);

  if (!scored.length) {
    return tools.ok({
      topic,
      matched: null,
      available: all.slice(0, 25).map((p) => tools.pick(p, ['id', 'title', 'category', 'version'])),
      link: ctx.portal === 'hr' ? '/policies.html' : '/ey/policies',
    }, 0, `No policy title or summary mentions "${topic}". These are the policies you can open — say which one and I will read it.`);
  }

  // Read the best match in full. One extra call, not one per policy.
  const best = scored[0].p;
  const full = await callAsUser(ctx.req, { path: `/api/policies/${best.id}` });
  const body = full.status === 200 && full.json
    ? String(full.json.content_md || full.json.content || full.json.body || '').slice(0, 4000)
    : '';
  // The page differs per portal: EY serves editions/ladn/public/ey/policies.html
  // at /ey/policies, HR serves its own at /policies.html. Neither reads an ?id=,
  // so the link opens the list — checked, rather than inventing a deep link that
  // silently does nothing.
  const link = ctx.portal === 'hr' ? '/policies.html' : '/ey/policies';
  return tools.ok({
    topic,
    policy: tools.pick(best, ['id', 'title', 'category', 'version', 'published_at', 'summary']),
    link,
    text: body || null,
    also_matched: scored.slice(1, 4).map((x) => tools.pick(x.p, ['id', 'title'])),
  }, 1, body ? undefined : 'Wren holds the policy but not its text — open it on the Policies page.');
}

module.exports = {
  eyfs, howto, policies, howtoVector, keywords, wordIn,
  HOWTO_COLLECTION, QDRANT_URL, HOWTO_FLOOR,
};
