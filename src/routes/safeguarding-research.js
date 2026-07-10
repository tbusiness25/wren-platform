'use strict';
/**
 * safeguarding-research.js — P5: guarded web-research tool for safeguarding queries.
 *
 * Purpose: enable locked-down tablets to get researched, sourced answers
 * without staff browsing the open web. Server-side search, result summarisation,
 * source URLs returned, every query logged to decision_log.
 *
 * Guardrails: only early-years / child-development / SEND / EYFS topics.
 * Off-topic queries are refused with an explanatory message.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { logDecision } = require('../lib/decision-log');
const { SearXNG_URL } = process.env.SEARXNG_URL || 'http://searxng:8080';

// All safeguarding-research routes require staff authentication
router.use(authenticate);

// Topic guardrails — allowed keywords for EY-safe search
const ALLOWED_TOPIC_PATTERNS = [
  'eyfs','early years','early-years','child develop','child development',
  'safeguard','safeguarding','send','special educational','inclusion',
  'inclusion','attachment','developmental milestone','disability',
  'autism','adhd','dyslexia','speech and language','communication',
  'behaviour','behavioural','neglect','abuse','physical abuse',
  'emotional abuse','sexual abuse','domestic','domestic violence',
  'online safety','cyberbullying','online safeguarding','child protection',
  'key person','key-person','attachment','play','play-based',
  'foundation stage','fundamental','pedagogy','pedagogical',
  'wellbeing','mental health','emotional','social care',
  'childcare','nursery','early-years','pediatric','paediatric',
];

function _isAllowedTopic(query) {
  const lower = query.toLowerCase();
  return ALLOWED_TOPIC_PATTERNS.some(pat => lower.includes(pat));
}

// GET /api/safeguarding-research?q=<query>
// Server-side search → fetch top results → summarise → log to decision_log
router.get('/', async (req, res) => {
  const query = (req.query.q || '').toString().trim();
  if (!query || query.length < 3) {
    return res.status(400).json({ error: 'Query must be at least 3 characters' });
  }

  // Guardrail: refuse off-topic queries
  if (!_isAllowedTopic(query)) {
    return res.status(403).json({
      error: 'Topic not permitted',
      message: 'This tool is for early-years and safeguarding research only. Allowed topics include: EYFS, child development, SEND, safeguarding, child protection, behaviour, wellbeing, and related early-years professional areas.',
    });
  }

  let results = [];
  let source = 'search';

  // Try SearXNG first, fall back to DuckDuckGo-safe fetch
  try {
    const searxRes = await fetch(
      `${SearXNG_URL}/search?q=${encodeURIComponent(query)}&categories=general&format=json`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (searxRes.ok) {
      const data = await searxRes.json();
      const hits = (data.results || []).slice(0, 5).map(r => ({
        title: r.title || '',
        url: r.url || '',
        content: (r.content || '').slice(0, 500),
      }));
      results = hits;
      source = 'searxng';
    }
  } catch (e) {
    // SearXNG unreachable — fall back to cached/known resources
    console.warn(`[safeguarding-research] SearXNG unreachable (${SearXNG_URL}): ${e.message}`);
  }

  // If no live results, provide curated safeguarding resources
  if (!results.length) {
    const curated = [
      {
        title: 'Working Together to Safeguard Children (2026)',
        url: 'https://www.gov.uk/government/publications/working-together-to-safeguard-children--2',
        content: 'Statutory guidance for agencies and individuals who should work to protect children. Covers multi-agency safeguarding, thresholds, and case management.',
      },
      {
        title: 'EYFS Framework (2024) — Safeguarding and Welfare Requirements',
        url: 'https://www.gov.uk/government/publications/early-years-foundation-stage-framework-outlining-the-delivery-standards--2',
        content: 'Statutory framework for the learning, development and care of children from birth to five years. Section 8 covers safeguarding and welfare requirements.',
      },
      {
        title: 'NSPCC Safeguarding Resources',
        url: 'https://www.nspcc.org.uk/keeping-children-safe/',
        content: 'Comprehensive safeguarding resources including signs of abuse, child protection procedures, and guidance for early years practitioners.',
      },
    ];
    // Search through curated for relevant content
    results = curated
      .filter(c => c.title.toLowerCase().includes(query.toLowerCase()) || c.content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 3);
    source = 'curated';
  }

  // Summarise results for the user
  const summary = results.map((r, i) =>
    `${i + 1}. **${r.title}**\n   ${r.content.replace(/\n/g, ' ')}\n   Source: ${r.url}`
  ).join('\n\n');

  // Log to decision_log
  let decisionId = null;
  try {
    decisionId = await logDecision({
      category: 'safeguarding_research',
      inputContext: {
        portal: req.user.role || 'unknown',
        staff_id: req.user.id,
        query_first_200: query.slice(0, 200),
      },
      optionsPresented: [
        { source: 'searxng', available: source === 'searxng' },
        { source: 'curated', available: source === 'curated' },
        { result_count: results.length },
      ],
      decisionMade: { summary_first_500: summary.slice(0, 500), sources: results.map(r => r.url) },
      decidedByAiModel: 'safeguarding-research-p5',
      relatedStaffId: req.user.id,
    });
  } catch (dlogErr) {
    console.error('[safeguarding-research] decision_log error (non-fatal):', dlogErr.message);
  }

  res.json({
    query,
    source,
    results,
    summary,
    decision_id: decisionId,
    guardrail_notice: 'This tool is restricted to early-years and safeguarding topics only.',
  });
});

// GET /api/safeguarding-research/guardrails
// Returns the allowed topic patterns for client-side pre-validation
router.get('/guardrails', async (_req, res) => {
  res.json({
    allowed_patterns: ALLOWED_TOPIC_PATTERNS,
    notice: 'Early-years and safeguarding topics only.',
  });
});

module.exports = router;
