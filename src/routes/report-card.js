'use strict';
/**
 * report-card.js — b187 (2026-08-19). Mounted at /api/report-card. Manager-gated.
 *
 * The Setting Report Card: an INTERNAL inspection-readiness indicator across the
 * four Ofsted EY inspection areas, scored only from records this setting already
 * holds. It is NOT an Ofsted grade and every response carries the disclaimer
 * saying so — see src/lib/report-card.js for the scoring model and the "no data
 * is excluded, never scored 0" rule.
 *
 *   GET  /api/report-card
 *          ?fresh=1        bypass the cached snapshot and recompute
 *          &save=0         compute without writing today's snapshot
 *        → { computed_at, cached, disclaimer, overall, domains[…sub_metrics],
 *            weakest[5], excluded[] }
 *
 *   GET  /api/report-card/trend?months=12
 *        → { points: [{snapshot_date, overall_score, rag, domains{…}}] } for the
 *          sparkline. Read straight off report_card_snapshots — no recompute.
 *
 *   GET  /api/report-card/metrics
 *        → the sub-metric catalogue (key, domain, label, weight, why, sources,
 *          link) with no numbers, so the model itself is auditable.
 *
 *   POST /api/report-card/snapshot
 *        → force today's snapshot now (the monthly one is written by the existing
 *          nightly job, scripts/report-engine-nightly.js --only=reportcard; there
 *          is deliberately NO new cron).
 *
 * Caching: the computed card is stored one-row-per-day in report_card_snapshots.
 * A GET inside CACHE_MINUTES of the stored computed_at is served from that row,
 * so opening the page repeatedly is cheap and the trend stays one point per day.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const {
  buildReportCard, saveSnapshot, ensureSnapshotTable, METRICS, DOMAINS, DISCLAIMER,
} = require('../lib/report-card');

router.use(authenticate);

const MGR_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];
const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, MGR_ROLES)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

const CACHE_MINUTES = parseInt(process.env.REPORT_CARD_CACHE_MINUTES || '60', 10);

/** Rebuild the full API shape from a stored snapshot row (no recompute). */
function fromSnapshot(row) {
  const s = row.scores || {};
  return {
    computed_at: row.computed_at,
    cached: true,
    snapshot_date: row.snapshot_date,
    disclaimer: DISCLAIMER,
    thresholds: s.thresholds || null,
    overall: s.overall || { score: row.overall_score, status: row.rag },
    domains: (s.domains || []).map(d => Object.assign({}, d, {
      // The stored shape keeps only what the page needs; re-attach the static
      // copy so a cached card renders identically to a fresh one.
      icon:  (DOMAINS.find(x => x.key === d.key) || {}).icon || '',
      blurb: (DOMAINS.find(x => x.key === d.key) || {}).blurb || '',
      sub_metrics: (d.sub_metrics || []).map(m => Object.assign({
        why:     (METRICS.find(x => x.key === m.key) || {}).why || null,
        sources: (METRICS.find(x => x.key === m.key) || {}).sources || [],
        domain:  d.key,
      }, m)),
    })),
    weakest: row.weakest || [],
    excluded: s.excluded || [],
  };
}

// GET /api/report-card
router.get('/', managerOnly, async (req, res) => {
  const db = getPool();
  const wantFresh = req.query.fresh === '1' || req.query.fresh === 'true';
  const wantSave  = !(req.query.save === '0' || req.query.save === 'false');

  try {
    await ensureSnapshotTable(db);

    if (!wantFresh) {
      const { rows } = await db.query(`
        SELECT computed_at, snapshot_date, overall_score, rag, scores, weakest
          FROM report_card_snapshots
         WHERE computed_at > now() - ($1::int * interval '1 minute')
         ORDER BY computed_at DESC LIMIT 1`, [CACHE_MINUTES]);
      if (rows.length) return res.json(fromSnapshot(rows[0]));
    }

    const card = await buildReportCard(db);
    let snapshot = null;
    if (wantSave) {
      try {
        snapshot = await saveSnapshot(db, card, 'api');
      } catch (e) {
        // A read of the card must never fail because the store is unavailable.
        console.error('report-card snapshot write failed:', e.message);
      }
    }
    res.json(Object.assign({ cached: false, snapshot_date: snapshot ? snapshot.snapshot_date : null }, card));
  } catch (err) {
    console.error('report-card error:', err.message);
    res.status(500).json({ error: 'Failed to build the report card' });
  }
});

// GET /api/report-card/trend — the sparkline series
router.get('/trend', managerOnly, async (req, res) => {
  const db = getPool();
  const months = Math.min(60, Math.max(1, parseInt(req.query.months, 10) || 12));
  try {
    await ensureSnapshotTable(db);
    const { rows } = await db.query(`
      SELECT snapshot_date, computed_at, overall_score, rag, source,
             scores -> 'domains' AS domains
        FROM report_card_snapshots
       WHERE snapshot_date >= current_date - ($1::int * 30)
       ORDER BY snapshot_date ASC`, [months]);
    res.json({
      months,
      count: rows.length,
      points: rows.map(r => ({
        snapshot_date: r.snapshot_date,
        computed_at: r.computed_at,
        overall_score: r.overall_score,
        rag: r.rag,
        source: r.source,
        domains: (r.domains || []).reduce((m, d) => (m[d.key] = d.score, m), {}),
      })),
    });
  } catch (err) {
    console.error('report-card/trend error:', err.message);
    res.status(500).json({ error: 'Failed to load the trend' });
  }
});

// GET /api/report-card/metrics — the scoring model itself, numbers not included
router.get('/metrics', managerOnly, (req, res) => {
  res.json({
    disclaimer: DISCLAIMER,
    domains: DOMAINS,
    metrics: METRICS.map(m => ({
      key: m.key, domain: m.domain, label: m.label, weight: m.weight,
      why: m.why, link: m.link, sources: m.sources,
    })),
  });
});

// POST /api/report-card/snapshot — write today's snapshot on demand
router.post('/snapshot', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const card = await buildReportCard(db);
    const row = await saveSnapshot(db, card, 'manual');
    res.json({ saved: row, overall: card.overall, computed_at: card.computed_at });
  } catch (err) {
    console.error('report-card/snapshot error:', err.message);
    res.status(500).json({ error: 'Failed to save the snapshot' });
  }
});

module.exports = router;
