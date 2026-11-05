'use strict';
/*
 * Termly key-child overview / review (additive, dev-first — 2026-08-03).
 *
 * End-of-term "key-child overview" for EY practitioners. For each of a
 * practitioner's key children it surfaces the term's activity (observations,
 * next steps, planned activities, photos), lets them generate a warm, factual
 * AI summary (local Ollama on Ascent), and captures the practitioner's own
 * short written evaluation which they can save as a draft or finalise.
 *
 * Access: a practitioner sees only their own key children; managers /
 * deputy-managers see all key children.
 *
 * Storage: ladn.termly_child_reviews (see CREATE TABLE in the build report).
 * Term boundaries come from ladn.funding_terms (name = term_label, year).
 *
 * This route READS child observation content server-side only, to build the
 * summary prompt — it never returns raw obs rows to the client; the client
 * receives per-child counts + the finished AI summary.
 */

const express = require('express');
const router  = express.Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');
const ai = require('../lib/ai-models');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const OLLAMA_URL   = ai.host();
// A careful written summary → ai-models.js role 'heavy', resolved per call.
// (b333: was OLLAMA_TERMLY_MODEL / OLLAMA_HELPER_MODEL / qwen3.6:35b-a3b.)
const SUMMARY_MODEL = () => ai.model('heavy');

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const isManager = (req) => hasRole(req.user, MANAGER_ROLES);

// ── Term resolution ──────────────────────────────────────────────────────────
// Given an optional term label + year, return {term_label, year, start_date,
// end_date}. Defaults to the current term (is_current), else most recent.
async function resolveTerm(db, term, year) {
  if (term && year) {
    const { rows } = await db.query(
      `SELECT name AS term_label, year, start_date, end_date
         FROM funding_terms WHERE name = $1 AND year = $2 LIMIT 1`,
      [term, parseInt(year, 10)]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await db.query(
    `SELECT name AS term_label, year, start_date, end_date
       FROM funding_terms
      ORDER BY is_current DESC NULLS LAST, start_date DESC LIMIT 1`);
  return rows[0] || null;
}

// Confirm the caller may act on this child (their key child, or a manager).
async function assertAccess(db, req, childId) {
  const { rows } = await db.query(
    `SELECT key_person_id FROM children WHERE id = $1`, [childId]);
  if (!rows[0]) return { ok: false, code: 404 };
  if (isManager(req)) return { ok: true };
  if (Number(rows[0].key_person_id) === Number(req.user.id)) return { ok: true };
  return { ok: false, code: 403 };
}

// ── GET /my?term=&year= ───────────────────────────────────────────────────────
// Key children (mine, or all for a manager) for the term, each with term stats
// and any existing review row.
router.get('/my', async (req, res) => {
  const db = getPool();
  try {
    const t = await resolveTerm(db, req.query.term, req.query.year);
    if (!t) return res.status(404).json({ error: 'No term configured' });

    // $1 start, $2 end are used by the stats LATERAL (kept first, fixed).
    const params = [t.start_date, t.end_date];
    const conds  = ['c.is_active = true', 'c.key_person_id IS NOT NULL'];
    if (!isManager(req)) {
      params.push(req.user.id);
      conds.push(`c.key_person_id = $${params.length}`);
    }
    const termIdx = params.length + 1;
    const yearIdx = params.length + 2;
    params.push(t.term_label, String(t.year));

    const { rows } = await db.query(`
      SELECT c.id AS child_id, c.first_name, c.last_name,
             c.first_name || ' ' || c.last_name AS name,
             c.room_id, r.name AS room_name,
             c.key_person_id,
             kp.first_name || ' ' || kp.last_name AS key_person_name,
             COALESCE(s.obs_count, 0)         AS obs_count,
             COALESCE(s.next_steps_count, 0)  AS next_steps_count,
             COALESCE(s.activities_count, 0)  AS activities_count,
             COALESCE(s.photo_count, 0)       AS photo_count,
             tr.id AS review_id, tr.ai_summary, tr.ai_generated_at,
             tr.evaluation, tr.status, tr.finalised_at
        FROM children c
        LEFT JOIN rooms r  ON r.id  = c.room_id
        LEFT JOIN staff kp ON kp.id = c.key_person_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS obs_count,
                 COUNT(*) FILTER (WHERE o.next_steps IS NOT NULL AND btrim(o.next_steps) <> '') AS next_steps_count,
                 COUNT(*) FILTER (WHERE o.planned_activity) AS activities_count,
                 COALESCE(SUM(COALESCE(array_length(o.photo_urls, 1), 0)), 0) AS photo_count
            FROM observations o
           WHERE o.child_id = c.id
             AND o.created_at::date BETWEEN $1 AND $2
        ) s ON true
        LEFT JOIN termly_child_reviews tr
          ON tr.child_id = c.id AND tr.term_label = $${termIdx} AND tr.term_year = $${yearIdx}
       WHERE ${conds.join(' AND ')}
       ORDER BY c.first_name, c.last_name
    `, params);

    res.json({
      term: {
        label: t.term_label,
        year: String(t.year),
        start_date: t.start_date,
        end_date: t.end_date,
      },
      is_manager: isManager(req),
      children: rows,
    });
  } catch (e) {
    console.error('[termly-reviews] /my error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// List available terms (for the term selector).
router.get('/terms', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT name AS label, year, start_date, end_date, is_current
         FROM funding_terms ORDER BY start_date DESC`);
    // b495 (L5) — String(null) is the 4-char string "null", not an empty value,
    // so a term row with no year rendered as "Autumn null" in the picker.
    res.json({ terms: rows.map(r => ({ ...r, year: r.year == null ? '' : String(r.year) })) });
  } catch (e) {
    console.error('[termly-reviews] /terms error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ── POST /:childId/generate ───────────────────────────────────────────────────
// Build the AI summary from the child's term data and store it.
router.post('/:childId/generate', async (req, res) => {
  const db = getPool();
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isFinite(childId)) return res.status(400).json({ error: 'bad childId' });
  try {
    const acc = await assertAccess(db, req, childId);
    if (!acc.ok) return res.status(acc.code).json({ error: acc.code === 404 ? 'not found' : 'forbidden' });

    const t = await resolveTerm(db, req.body.term || req.query.term, req.body.year || req.query.year);
    if (!t) return res.status(404).json({ error: 'No term configured' });

    const { rows: crows } = await db.query(
      `SELECT first_name FROM children WHERE id = $1`, [childId]);
    const firstName = crows[0] ? crows[0].first_name : 'This child';

    const { rows: obs } = await db.query(`
      SELECT o.created_at::date AS d, o.title, o.observation_text, o.next_steps,
             o.eyfs_areas, o.subject_areas, o.planned_activity,
             COALESCE(array_length(o.photo_urls, 1), 0) AS photos
        FROM observations o
       WHERE o.child_id = $1 AND o.created_at::date BETWEEN $2 AND $3
       ORDER BY o.created_at DESC`, [childId, t.start_date, t.end_date]);

    const stats = {
      obs: obs.length,
      next_steps: obs.filter(o => o.next_steps && o.next_steps.trim()).length,
      activities: obs.filter(o => o.planned_activity).length,
      photos: obs.reduce((a, o) => a + (o.photos || 0), 0),
    };

    // Most-observed areas of learning.
    const areaCount = {};
    for (const o of obs) {
      for (const a of [].concat(o.eyfs_areas || [], o.subject_areas || [])) {
        if (a) areaCount[a] = (areaCount[a] || 0) + 1;
      }
    }
    const topAreas = Object.entries(areaCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);

    // Bounded, cleaned sample of observation highlights.
    const sample = obs.slice(0, 20).map(o => {
      const txt = String(o.observation_text || o.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const ns  = String(o.next_steps || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!txt && !ns) return null;
      return `- (${o.d}) ${txt}${ns ? ` [Next step: ${ns}]` : ''}`;
    }).filter(Boolean).join('\n');

    const prompt = `You are an experienced EYFS key person at an English day nursery, writing a warm, factual end-of-term learning summary about one key child for the practitioner's own review. Use ONLY the information provided below — do not invent milestones, events, or names. Write in a positive, strengths-based EYFS tone. Refer to the child by first name only. Output 1-2 short paragraphs (no headings, no bullet points, roughly 120-180 words).

Child first name: ${firstName}
Term: ${t.term_label} ${t.year}
This term the key person recorded: ${stats.obs} observations, ${stats.next_steps} with next steps, ${stats.activities} planned activities, ${stats.photos} photos.
Areas of learning most observed: ${topAreas.join(', ') || 'not recorded'}.

Observation highlights (most recent first):
${sample || '(no observation text recorded this term)'}

Write the summary now:`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 120000);
    const model = SUMMARY_MODEL();   // resolved once: the model asked is the model returned
    let summary = '';
    try {
      const r = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false, think: false,
          options: ai.options({ temperature: 0.4, num_predict: 500 }),
        }),
        signal: controller.signal,
      });
      clearTimeout(to);
      if (!r.ok) throw new Error(`ollama ${r.status}`);
      const data = await r.json();
      summary = String(data.response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (e) {
      clearTimeout(to);
      console.error('[termly-reviews] ollama error:', e.message);
      return res.status(502).json({ error: 'AI summary failed', detail: e.message });
    }
    if (!summary) return res.status(502).json({ error: 'empty summary' });

    // Upsert: refresh the AI summary, preserve any existing evaluation/status.
    const { rows: up } = await db.query(`
      INSERT INTO termly_child_reviews
        (child_id, staff_id, term_label, term_year, ai_summary, ai_generated_at, status)
      VALUES ($1, $2, $3, $4, $5, now(), 'draft')
      ON CONFLICT (child_id, term_label, term_year)
      DO UPDATE SET ai_summary = EXCLUDED.ai_summary,
                    ai_generated_at = now(),
                    staff_id = COALESCE(termly_child_reviews.staff_id, EXCLUDED.staff_id)
      RETURNING id, status`,
      [childId, req.user.id, t.term_label, String(t.year), summary]);

    res.json({ ok: true, summary, stats, review_id: up[0].id, status: up[0].status, model });
  } catch (e) {
    console.error('[termly-reviews] generate error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ── PUT /:childId ─────────────────────────────────────────────────────────────
// Save the practitioner's written evaluation + status (draft | finalised).
router.put('/:childId', async (req, res) => {
  const db = getPool();
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isFinite(childId)) return res.status(400).json({ error: 'bad childId' });
  const evaluation = String(req.body.evaluation || '');
  const status = ['draft', 'finalised'].includes(req.body.status) ? req.body.status : 'draft';
  try {
    const acc = await assertAccess(db, req, childId);
    if (!acc.ok) return res.status(acc.code).json({ error: acc.code === 404 ? 'not found' : 'forbidden' });

    const t = await resolveTerm(db, req.body.term || req.query.term, req.body.year || req.query.year);
    if (!t) return res.status(404).json({ error: 'No term configured' });

    const { rows } = await db.query(`
      INSERT INTO termly_child_reviews
        (child_id, staff_id, term_label, term_year, evaluation, status, finalised_at)
      VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'finalised' THEN now() ELSE NULL END)
      ON CONFLICT (child_id, term_label, term_year)
      DO UPDATE SET evaluation = EXCLUDED.evaluation,
                    status = EXCLUDED.status,
                    finalised_at = CASE WHEN EXCLUDED.status = 'finalised' THEN now() ELSE NULL END,
                    staff_id = COALESCE(termly_child_reviews.staff_id, EXCLUDED.staff_id)
      RETURNING id, status, finalised_at`,
      [childId, req.user.id, t.term_label, String(t.year), evaluation, status]);

    res.json({ ok: true, review: rows[0] });
  } catch (e) {
    console.error('[termly-reviews] put error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
