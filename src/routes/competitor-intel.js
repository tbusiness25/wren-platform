'use strict';
// Competitor intelligence (Wren Intelligence submodule).
// PUBLIC-DATA ONLY: competitor websites, Ofsted, and public search results via the
// local SearXNG. Local Ollama (Ascent) extracts structured fields + scores sentiment.
// It NEVER contacts a competitor pretending to be a parent — pricing gaps are surfaced
// for Toby to act on himself.

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://your-server:8082';
// b333: host and model from ai-models.js, resolved per call. qwen3.8:27b is a thinking
// model — left to itself it spends the token budget on hidden reasoning and returns an
// empty `response`, so every request sends think:false.
const ai = require('../lib/ai-models');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const OUR_TERMS = ['"Your Nursery" Ealing', 'example-nursery reviews'];

router.use(authenticate);
router.use((req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

// ── helpers ───────────────────────────────────────────────────────────────────
async function searxng(query, { timeout = 12000 } = {}) {
  try {
    const r = await fetch(`${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`,
      { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content || '', engine: x.engine }));
  } catch { return []; }
}

async function ollamaJSON(prompt, { timeout = 45000 } = {}) {
  try {
    const r = await fetch(`${ai.host()}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ai.model('heavy'), prompt, stream: false, think: false, options: ai.options({ temperature: 0.1, num_predict: 700 }) }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const m = (d.response || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function fetchPageText(url, { timeout = 12000 } = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WrenIntel/1.0)' } });
    if (!r.ok) return '';
    const html = await r.text();
    return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  } catch { return ''; }
}

// ── OUR nursery stats (all real DB data) ─────────────────────────────────────
router.get('/us', async (req, res) => {
  try {
    const db = getPool();
    const rooms = (await db.query(
      `SELECT name, capacity, monthly_fee_pence, min_age_months, max_age_months FROM rooms ORDER BY id`)).rows;
    const staff = (await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE qualification_level >= 3)::int AS level3,
             COUNT(*) FILTER (WHERE qualification_level >= 2)::int AS level2plus
      FROM staff WHERE is_active=true AND COALESCE(role,'') <> 'parent'`)).rows[0];
    const pfa = (await db.query(`
      SELECT COUNT(DISTINCT staff_id)::int AS n FROM mandatory_training
      WHERE training_type ILIKE '%first_aid%'
        AND (expiry_date >= CURRENT_DATE OR (expiry_date IS NULL AND completed_date >= CURRENT_DATE - INTERVAL '3 years'))`)).rows[0];
    res.json({
      name: 'Your Nursery',
      rooms: rooms.map(r => ({
        name: r.name, capacity: r.capacity,
        monthly_fee: r.monthly_fee_pence != null ? '£' + (r.monthly_fee_pence / 100).toFixed(0) : null,
        age_range: `${r.min_age_months}–${r.max_age_months}m`,
      })),
      staff: { total: staff.total, level3: staff.level3, level2plus: staff.level2plus, first_aiders: pfa.n },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── competitors CRUD ──────────────────────────────────────────────────────────
router.get('/competitors', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT c.*, (SELECT count(*) FROM competitor_intel ci WHERE ci.competitor_id=c.id)::int AS intel_count
      FROM competitors c WHERE active=true ORDER BY name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/competitors', express.json(), async (req, res) => {
  const { name, postcode, website, ofsted_urn, distance_note, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO competitors (name, postcode, website, ofsted_urn, distance_note, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, postcode || null, website || null, ofsted_urn || null, distance_note || null, notes || null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/competitors/:id', express.json(), async (req, res) => {
  const { name, postcode, website, ofsted_urn, distance_note, notes } = req.body || {};
  try {
    const { rows } = await getPool().query(
      `UPDATE competitors SET name=COALESCE($2,name), postcode=$3, website=$4, ofsted_urn=$5,
         distance_note=$6, notes=$7, updated_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id, name || null, postcode || null, website || null, ofsted_urn || null, distance_note || null, notes || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/competitors/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(`UPDATE competitors SET active=false WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/competitors/:id/intel', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM competitor_intel WHERE competitor_id=$1 ORDER BY kind, captured_at DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── refresh a competitor: website extraction + Ofsted lookup ──────────────────
router.post('/competitors/:id/refresh', async (req, res) => {
  try {
    const db = getPool();
    const { rows: cr } = await db.query(`SELECT * FROM competitors WHERE id=$1`, [req.params.id]);
    if (!cr.length) return res.status(404).json({ error: 'Not found' });
    const c = cr[0];
    const added = [];

    // 1) Website: fetch + LLM-extract fees/ages/rooms/consumables.
    if (c.website) {
      const text = await fetchPageText(c.website);
      if (text) {
        const ext = await ollamaJSON(
          `From this UK day-nursery website text, extract what you can as JSON with keys: ` +
          `"fees" (array of short strings like "Full day £75"), "age_range" (string), ` +
          `"rooms" (array of room names), "consumables_included" (string: what's included e.g. meals/nappies). ` +
          `Only include facts stated in the text. If unknown, use null/empty.\n\nTEXT:\n${text}`);
        if (ext) {
          const push = (kind, label, value) => value && added.push({ kind, label, value, source_url: c.website, confidence: 'low' });
          const feeStr = f => (f && typeof f === 'object')
            ? [f.type || f.label || f.name, f.price || f.amount || f.value].filter(Boolean).join(' ')
            : String(f);
          (ext.fees || []).slice(0, 8).forEach(f => push('fee', 'fee', feeStr(f)));
          push('age', 'age range', ext.age_range);
          (ext.rooms || []).slice(0, 8).forEach(r => push('rooms', 'room', String(r)));
          push('consumables', 'consumables', ext.consumables_included);
        }
      }
    }

    // 2) Ofsted rating via public search.
    const oq = await searxng(`${c.name} ${c.postcode || ''} Ofsted rating early years`);
    const ofstedHit = oq.find(r => /ofsted|reports\.ofsted/i.test(r.url + r.title));
    if (ofstedHit) {
      const grade = (ofstedHit.snippet.match(/\b(Outstanding|Good|Requires improvement|Inadequate)\b/i) || [])[0];
      if (grade) added.push({ kind: 'ofsted', label: 'Ofsted', value: grade, source_url: ofstedHit.url, confidence: 'medium' });
    }

    // Store (replace this competitor's intel with the fresh snapshot).
    await db.query(`DELETE FROM competitor_intel WHERE competitor_id=$1`, [c.id]);
    for (const a of added) {
      await db.query(
        `INSERT INTO competitor_intel (competitor_id, kind, label, value, source_url, confidence)
         VALUES ($1,$2,$3,$4,$5,$6)`, [c.id, a.kind, a.label, a.value, a.source_url, a.confidence]);
    }
    await db.query(`UPDATE competitors SET updated_at=now() WHERE id=$1`, [c.id]);
    res.json({ ok: true, added: added.length, intel: added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── social mentions of US ─────────────────────────────────────────────────────
router.get('/mentions', async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT * FROM social_mentions ORDER BY captured_at DESC LIMIT 100`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mentions/refresh', async (req, res) => {
  try {
    const db = getPool();
    let found = 0, added = 0;
    for (const term of OUR_TERMS) {
      const results = await searxng(term);
      for (const r of results.slice(0, 10)) {
        found++;
        if (!r.url) continue;
        // sentiment via local model (best-effort)
        let sentiment = 'unknown';
        const s = await ollamaJSON(
          `Classify the sentiment of this search result about a nursery as JSON {"sentiment":"positive|neutral|negative"}.\nTITLE: ${r.title}\nTEXT: ${r.snippet}`,
          { timeout: 20000 });
        if (s && s.sentiment) sentiment = s.sentiment;
        const ins = await db.query(
          `INSERT INTO social_mentions (source, url, title, snippet, sentiment, matched_term)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (url) DO UPDATE SET snippet=EXCLUDED.snippet, sentiment=EXCLUDED.sentiment, captured_at=now()
           RETURNING (xmax=0) AS inserted`,
          [r.engine || 'web', r.url, r.title || '', r.snippet || '', sentiment, term]);
        if (ins.rows[0]?.inserted) added++;
      }
    }
    res.json({ ok: true, searched: OUR_TERMS.length, found, new: added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// b203 — Competitor FEE intelligence + the April fee review.  (2026-08-19)
//
// Appended to the existing module rather than split into a new one: this is the same
// question ("what does everyone else charge, and what should we do about it?") the
// Competitor Intelligence page already asks, and the ethics rules at the top of this file —
// public data only, no impersonation, no fake enquiries — govern it unchanged.
//
// Everything below is READ + SCRAPE + RECOMMEND. There is deliberately no endpoint that
// writes a fee: the April review produces a document, and applying it stays a human act.
// ═══════════════════════════════════════════════════════════════════════════════

const { runFeeScrape } = require('../lib/competitor-fee-scrape');
const feeReviewModel   = require('../lib/fee-review-model');
const { requireSalaryView } = require('../lib/capabilities');

// ── sources ──────────────────────────────────────────────────────────────────

router.get('/fees/sources', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT s.*,
             (SELECT COUNT(*) FROM competitor_fees f
               WHERE f.provider_key = s.provider_key AND f.fee_pence IS NOT NULL)::int AS fee_points
      FROM competitor_fee_sources s ORDER BY s.active DESC, s.provider_name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/fees/sources/:id', express.json(), async (req, res) => {
  const { url, active, note, crawl_delay_ms, competitor_id } = req.body || {};
  try {
    const { rows } = await getPool().query(`
      UPDATE competitor_fee_sources
         SET url = COALESCE($2, url), active = COALESCE($3, active), note = COALESCE($4, note),
             crawl_delay_ms = GREATEST(COALESCE($5, crawl_delay_ms), 1000),
             competitor_id = COALESCE($6, competitor_id), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, url || null, active ?? null, note || null, crawl_delay_ms || null, competitor_id || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── run the scrape ───────────────────────────────────────────────────────────
// Also called by the weekly competitor-refresh cron. `provider_key` re-runs one source,
// which is what you want after fixing a parser rather than re-hitting eight sites.
router.post('/fees/scrape', express.json(), async (req, res) => {
  try {
    const out = await runFeeScrape({
      triggeredBy: `staff:${req.user.id}`,
      onlyKey: (req.body && req.body.provider_key) || null,
    });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fees/runs', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM competitor_fee_runs ORDER BY started_at DESC LIMIT 26`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── the fees themselves ──────────────────────────────────────────────────────
// Defaults to the latest completed run. `needs_review=1` is the manual-review queue:
// everything the scraper was not confident about, with the raw text it read.
router.get('/fees/latest', async (req, res) => {
  try {
    const db = getPool();
    // Latest SCRAPE run. Manual entries create their own single-row run (so the fee still has
    // a dated provenance), and letting one of those become "the latest run" would empty this
    // screen and the review queue with it.
    const runId = req.query.run_id
      || (await db.query(
            `SELECT id FROM competitor_fee_runs
              WHERE finished_at IS NOT NULL AND triggered_by NOT LIKE 'manual:%'
              ORDER BY started_at DESC LIMIT 1`)).rows[0]?.id;
    if (!runId) return res.json({ run_id: null, fees: [] });

    const where = ['run_id = $1'];
    const params = [runId];
    if (req.query.needs_review === '1') where.push('needs_review = true');
    if (req.query.provider_key) { params.push(req.query.provider_key); where.push(`provider_key = $${params.length}`); }
    if (req.query.age_band)     { params.push(req.query.age_band);     where.push(`age_band = $${params.length}`); }

    const { rows } = await db.query(
      `SELECT * FROM competitor_fees WHERE ${where.join(' AND ')}
       ORDER BY provider, age_band, session_type, days_per_week DESC NULLS LAST`, params);
    res.json({ run_id: Number(runId), count: rows.length, fees: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * A fee obtained by hand — the honest way to fill the gaps the scraper refuses to.
 * Busy Bees put their fee sheet behind a details-capture form and we will not submit it;
 * if Toby is sent that sheet by a parent or asks them directly, this is where it goes, with
 * the quote and who provided it, so the comparison grid can say where the number came from.
 */
router.post('/fees/manual', express.json(), async (req, res) => {
  const b = req.body || {};
  if (!b.provider_key || !b.fee_pence || !b.period) {
    return res.status(400).json({ error: 'provider_key, fee_pence and period are required' });
  }
  if (!b.source_quote) {
    return res.status(400).json({ error: 'source_quote is required — a manually entered fee still has to say where it came from' });
  }
  try {
    const db = getPool();
    const { rows: [src] } = await db.query(
      `SELECT provider_name, url FROM competitor_fee_sources WHERE provider_key = $1`, [b.provider_key]);
    const { rows: [run] } = await db.query(
      `INSERT INTO competitor_fee_runs (triggered_by, sources_total, sources_parsed, finished_at, summary)
       VALUES ($1, 1, 1, now(), $2) RETURNING id`,
      [`manual:${req.user.id}`, JSON.stringify([{ provider_key: b.provider_key, status: 'manual' }])]);

    const { rows } = await db.query(`
      INSERT INTO competitor_fees
        (run_id, provider_key, provider, url, age_band, room_label, session_type, days_per_week,
         funding_basis, fee_pence, period, day_equiv_pence, day_equiv_basis, effective_date,
         source_quote, confidence, needs_review, parse_note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,false,$17) RETURNING *`,
      [run.id, b.provider_key, b.provider || src?.provider_name || b.provider_key,
       b.url || src?.url || '', b.age_band || 'unknown', b.room_label || null,
       b.session_type || 'full_day', b.days_per_week || null, b.funding_basis || 'standard',
       b.fee_pence, b.period, b.day_equiv_pence || (b.period === 'day' ? b.fee_pence : null),
       b.period === 'day' ? 'provider quotes a per-day rate' : (b.day_equiv_basis || null),
       b.effective_date || null, b.source_quote, b.confidence || 'high',
       `Entered by hand${b.obtained_from ? ` (obtained from: ${b.obtained_from})` : ''} by staff ${req.user.id}.`]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── comparison: us vs each competitor, by band ───────────────────────────────
router.get('/fees/comparison', async (req, res) => {
  try {
    const [fees, mkt] = await Promise.all([
      feeReviewModel.ourFees(getPool()),
      feeReviewModel.market(getPool()),
    ]);
    const bands = feeReviewModel.BANDS.map(band => {
      const ours = fees[band] || null;
      const m = mkt.available ? mkt.bands[band] : { providers: [], n: 0, median_day_pence: null };
      return {
        age_band: band,
        label: feeReviewModel.BAND_LABEL[band],
        ours,
        median_day_pence: m.median_day_pence,
        median_day_gbp: m.median_day_pence == null ? null : Math.round(m.median_day_pence) / 100,
        // The gap is expressed FROM our price: positive means the market is dearer than us.
        gap_to_median_pence: (ours && m.median_day_pence) ? m.median_day_pence - ours.day_pence : null,
        gap_to_median_pct: (ours && m.median_day_pence)
          ? Math.round(((m.median_day_pence - ours.day_pence) / ours.day_pence) * 1000) / 10 : null,
        competitors: m.providers.map(p => ({
          ...p,
          gap_pence: ours ? p.day_pence - ours.day_pence : null,
          gap_pct: ours ? Math.round(((p.day_pence - ours.day_pence) / ours.day_pence) * 1000) / 10 : null,
        })),
      };
    });
    res.json({
      available: mkt.available, run_id: mkt.run_id, scraped_at: mkt.scraped_at,
      note: mkt.note || mkt.reason, bands,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * Trend: one per-day figure per provider per run, so the history the weekly cron builds up
 * turns into a line rather than a pile.  Sparse by design — a provider that could not be
 * read that week has no point, which is the truthful shape.
 */
router.get('/fees/trend', async (req, res) => {
  const band = req.query.age_band || 'under_2';
  try {
    const { rows } = await getPool().query(`
      SELECT r.id AS run_id, r.started_at::date AS on_date, f.provider, f.provider_key,
             MIN(f.day_equiv_pence)::int AS day_pence
      FROM competitor_fees f
      JOIN competitor_fee_runs r ON r.id = f.run_id
      WHERE f.day_equiv_pence IS NOT NULL AND f.funding_basis = 'standard'
        AND f.confidence IN ('high','medium')
        AND (f.age_band = $1 OR (f.age_band = 'over_2' AND $1 <> 'under_2'))
        AND r.started_at >= CURRENT_DATE - INTERVAL '18 months'
      GROUP BY r.id, r.started_at, f.provider, f.provider_key
      ORDER BY r.started_at, f.provider`, [band]);
    res.json({ age_band: band, points: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fees/benchmarks', async (req, res) => {
  try { res.json(await feeReviewModel.benchmarks(getPool())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── the April fee review ─────────────────────────────────────────────────────
// Payroll-derived, so gated on view_staff_salaries on top of the module's manager check —
// a deputy can see the competitor grid but not the wage bill it is compared against.

router.get('/fee-review', requireSalaryView, async (req, res) => {
  try {
    res.json(await feeReviewModel.buildFeeReview({
      reviewYear: parseInt(req.query.year) || (new Date().getFullYear() + 1),
      oncostPct: req.query.oncost_pct != null ? parseFloat(req.query.oncost_pct) : undefined,
      wageInflationPct: req.query.wage_inflation_pct != null ? parseFloat(req.query.wage_inflation_pct) : null,
      maxIncreasePct: req.query.max_pct != null ? parseFloat(req.query.max_pct) : undefined,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fee-review/snapshots', requireSalaryView, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, review_year, title, decided, decided_note, created_at,
              recommendation, (inputs->'market'->>'scraped_at') AS market_scraped_at
       FROM fee_review_snapshots ORDER BY created_at DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Save the review as it stands, so September's evidence is still there in April. */
router.post('/fee-review/save', requireSalaryView, express.json(), async (req, res) => {
  try {
    const year = parseInt(req.body?.year) || (new Date().getFullYear() + 1);
    const review = await feeReviewModel.buildFeeReview({
      reviewYear: year,
      wageInflationPct: req.body?.wage_inflation_pct ?? null,
      oncostPct: req.body?.oncost_pct ?? undefined,
    });
    const { rows } = await getPool().query(`
      INSERT INTO fee_review_snapshots (review_year, title, inputs, workings, recommendation, created_by)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, review_year, title, created_at`,
      [year, req.body?.title || `April ${year} fee review`,
       JSON.stringify(review.inputs), JSON.stringify({ ...review.workings, meta: review.meta, caveats: review.caveats }),
       JSON.stringify(review.recommendation), req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/fee-review/snapshots/:id/decide', requireSalaryView, express.json(), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE fee_review_snapshots SET decided = true, decided_note = $2 WHERE id = $1
       RETURNING id, decided, decided_note`,
      [req.params.id, req.body?.note || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * The September deliverable: one printable page Toby can take to a decision.  Served as
 * HTML rather than a generated PDF so it prints from the browser with working links back to
 * every source — the whole value of the page is that each number can be checked.
 */
router.get('/fee-review/export', requireSalaryView, async (req, res) => {
  try {
    const r = await feeReviewModel.buildFeeReview({
      reviewYear: parseInt(req.query.year) || (new Date().getFullYear() + 1),
      wageInflationPct: req.query.wage_inflation_pct != null ? parseFloat(req.query.wage_inflation_pct) : null,
    });
    const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    // Thousands separators: this page is printed and read across a table, where "£20701.20"
    // is genuinely harder to take in at a glance than "£20,701.20".
    const money = p => (p == null ? '—'
      : '£' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const pct = n => (n == null ? '—' : n + '%');

    const rows = r.recommendation.map(x => `
      <tr>
        <td><b>${esc(x.label)}</b></td>
        <td class="n">${money(x.current_day_pence)}</td>
        <td class="n big">${x.suggested_pct}%</td>
        <td class="n">${money(x.suggested_day_pence)}</td>
        <td class="n">${x.local_median_day_gbp == null ? '—' : '£' + x.local_median_day_gbp.toFixed(2)}</td>
        <td class="n">${pct(x.occupancy_pct)}</td>
        <td class="n">${x.extra_annual_pence == null ? '—' : money(x.extra_annual_pence)}</td>
      </tr>`).join('');

    const workings = r.recommendation.map(x => `
      <div class="w"><h3>${esc(x.label)} — ${x.suggested_pct}% (${money(x.current_day_pence)} → ${money(x.suggested_day_pence)})</h3>
      <ul>${x.reasoning.map(l => `<li${/^WARNING/.test(l) ? ' class="warn"' : ''}>${esc(l)}</li>`).join('')}</ul></div>`).join('');

    const comp = r.inputs.market.available
      ? feeReviewModel.BANDS.map(b => {
          const m = r.inputs.market.bands[b];
          if (!m.providers.length) return '';
          return `<h4>${esc(m.label)}</h4><table class="t"><tr><th>Provider</th><th>Per-day</th><th>Basis</th><th>Quoted from</th></tr>` +
            m.providers.map(p => `<tr><td>${esc(p.provider)}</td><td class="n">£${p.day_gbp.toFixed(2)}</td>` +
              `<td>${esc(p.basis)}${p.quoted_for ? ' — ' + esc(p.quoted_for) : ''}` +
                `${p.not_like_for_like ? `<br><span class="warn">${esc(p.not_like_for_like)}</span>` : ''}</td>` +
              `<td class="q"><a href="${esc(p.url)}" target="_blank">${esc((p.source_quote || '').slice(0, 130))}</a></td></tr>`).join('') +
            '</table>';
        }).join('')
      : `<p class="warn">${esc(r.inputs.market.reason)}</p>`;

    res.set('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>April ${r.meta.review_year} fee review — Your Nursery</title>
<style>
 body{font:13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:900px;margin:24px auto;padding:0 20px}
 h1{font-size:20px;margin:0 0 2px} h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
 h3{font-size:13px;margin:12px 0 4px} h4{font-size:12px;margin:12px 0 4px;color:#555}
 .sub{color:#666;font-size:11px;margin-bottom:14px}
 table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}
 th{text-align:left;background:#f4f6f8;padding:6px;border:1px solid #e2e6ea;font-weight:600}
 td{padding:6px;border:1px solid #e8ecef;vertical-align:top}
 .n{text-align:right;white-space:nowrap} .big{font-weight:700;font-size:14px}
 .q{font-size:10px;color:#555} .q a{color:#2c6e9b;text-decoration:none}
 ul{margin:4px 0 4px 18px;padding:0} li{margin:2px 0}
 li.warn,p.warn{color:#a4400a;font-weight:600}
 .box{background:#fbfcfd;border:1px solid #e2e6ea;border-radius:6px;padding:10px 12px;margin:10px 0}
 .cav li{color:#8a4b00}
 .disc{font-size:11px;color:#666;font-style:italic;margin-top:6px}
 @media print{body{margin:0;max-width:none} h2{page-break-after:avoid} .w{page-break-inside:avoid}}
</style></head><body>
<h1>April ${r.meta.review_year} fee review — Your Nursery</h1>
<div class="sub">Prepared ${new Date(r.meta.generated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
 · market data from the fee scrape of ${r.inputs.market.available ? new Date(r.inputs.market.scraped_at).toLocaleDateString('en-GB') : 'n/a'}
 · staff cost basis: ${esc(r.inputs.staff_cost.basis)}</div>

<h2>Recommendation</h2>
<table><tr><th>Room / band</th><th class="n">Now</th><th class="n">Suggested</th><th class="n">New rate</th>
<th class="n">Local median</th><th class="n">Occupancy</th><th class="n">Extra / yr</th></tr>${rows}</table>
<div class="box">At today's occupancy this adds <b>${money(r.workings.extra_annual_pence)}</b> a year
 (${money(r.workings.extra_weekly_pence)} a week). Margin moves from
 <b>${pct(r.workings.margin_now_pct)}</b> to <b>${pct(r.workings.margin_after_pct)}</b> once the assumed
 ${r.meta.wage_inflation_pct}% staff-cost increase is applied to the cost side as well.</div>
<div class="disc">${esc(r.meta.disclaimer)}</div>

<h2>How each number was reached</h2>${workings}

<h2>What the local market publishes</h2>
<p class="sub">Standard (unfunded) rates, converted to a per-day equivalent using each provider's own stated
weeks-per-year factor. Click a quote to open the page it was read from.</p>
${comp}

<h2>Published benchmarks</h2>
<table class="t"><tr><th>Scope</th><th>Measure</th><th class="n">Value</th><th>Source</th></tr>
${r.inputs.benchmarks.map(b => `<tr><td>${esc(b.scope_label)}</td><td>${esc(b.label)}</td>
<td class="n">${b.value_gbp == null ? '—' : '£' + b.value_gbp.toFixed(2) + (b.period ? '/' + esc(b.period) : '')}</td>
<td class="q"><a href="${esc(b.source_url)}" target="_blank">${esc(b.source_name)}</a></td></tr>`).join('')}
</table>

<h2>Read this before deciding</h2>
<ul class="cav">${r.caveats.map(c => `<li>${esc(c)}</li>`).join('') || '<li>None — every input was available.</li>'}</ul>
</body></html>`);
  } catch (e) { res.status(500).send(`<pre>Export failed: ${e.message}</pre>`); }
});

module.exports = router;
