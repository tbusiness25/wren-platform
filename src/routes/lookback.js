'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * lookback.js — b523 (2026-10-20) — mounted at /api/lookback.
 *
 * The server end of Roost → Curriculum → 🔭 Look back (/lookback.html): the
 * inset-day report on how the children have been progressing over one to five
 * years, with a presenter mode for a projector and an exportable slide pack.
 *
 * ── GATING ────────────────────────────────────────────────────────────────────
 * authenticate → the Roost (admin) portal → role manager / admin / owner /
 * headteacher. Both gates are server-side and both are checked before anything
 * is read.
 *
 * NO CAPABILITY IS ADDED ON TOP, and that is a deliberate choice rather than an
 * omission. b505 learnt that requireCapability() on a route which is already
 * manager-gated changes nothing — hasCapability() gives a manager a blanket
 * pass unless the key is in MATRIX_REQUIRED_CAPS — so the Permissions screen
 * would grow a switch that switches nothing, which is the exact lie b237 exists
 * to stop that screen telling. Toby asked for manager-only; the role gate IS
 * manager-only. If this should later be opened to the deputy for an inset day,
 * that is one line here plus a real MATRIX_REQUIRED_CAPS entry, together.
 *
 * On production, /api/lookback also sits behind ROOST_ONLY_PREFIXES in
 * server-unified.js, so it additionally requires being on the Roost
 * person-allowlist (today: Toby alone).
 *
 * ── GDPR ──────────────────────────────────────────────────────────────────────
 * Nothing that leaves this router names or identifies a child. There is no child
 * id, no date of birth, no name and no narrative text in any response — a date
 * of birth is turned into a room inside the SQL and never reaches JavaScript.
 * Suppression (any group under five distinct children) happens in
 * src/lib/lookback-stats.js, inside the payload, so a template cannot leak what
 * it was never given, and the slide pack and the CSV inherit the rule for free.
 *
 * The report engine is READ ONLY — src/lib/lookback-metrics.js contains no
 * INSERT, UPDATE or DELETE. The only writes in this file are to
 * ladn.lookback_notes: what the staff said about a chart on the day.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const router  = express.Router();

const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');

const T = require('../lib/lookback-terms');
const S = require('../lib/lookback-stats');
const M = require('../lib/lookback-metrics');
const pack = require('../lib/lookback-pack');

const MANAGER_ROLES = ['manager', 'admin', 'owner', 'headteacher'];

// ── The guard ────────────────────────────────────────────────────────────────
// A request with no portal is REFUSED rather than defaulted. Failing open on a
// whole-setting report is not a trade-off worth making, and the same shape is
// what cameras.js and security-hub.js already use.
function managerRoostOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'Look back is available on the Roost (admin) portal only.',
    });
  }
  const role = req.user && req.user.role;
  if (!req.user || !MANAGER_ROLES.includes(role)) {
    return res.status(403).json({
      error: 'forbidden_role',
      message: 'Manager access only — Look back reports on the whole setting.',
    });
  }
  next();
}

const guard = [authenticate, managerRoostOnly];

router.use(express.json({ limit: '32kb' }));

function yearsOf(req) {
  const n = Number(req.query.years);
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : null;
}

async function defaultYears(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'lookback_default_years'`);
    const n = Number(rows[0] && rows[0].value);
    return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 3;
  } catch (_) { return 3; }
}

function sectionsOf(req) {
  const raw = String(req.query.sections || '').trim();
  return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : null;
}

// ── GET /meta — what the page needs before it asks for anything heavy ────────
router.get('/meta', guard, async (req, res) => {
  const db = getPool();
  try {
    const years = await defaultYears(db);
    const today = T.todayYmd();
    // How far back there is anything to look at. Counts only.
    const { rows } = await db.query(`
      SELECT (SELECT min(created_at)::date FROM observations)     AS first_observation,
             (SELECT min(date)             FROM attendance)       AS first_register,
             (SELECT min(created_at)::date FROM next_steps)       AS first_next_step,
             (SELECT min(assessed_at)::date FROM framework_tracker) AS first_tracker_cell,
             (SELECT count(*)::int FROM observations)             AS observations,
             (SELECT count(*)::int FROM attendance)               AS register_rows,
             (SELECT count(*)::int FROM next_steps)               AS next_steps,
             (SELECT count(*)::int FROM framework_tracker)        AS tracker_cells`);
    const e = rows[0] || {};
    const earliest = [e.first_observation, e.first_register, e.first_next_step, e.first_tracker_cell]
      .map(T.ymd).filter(Boolean).sort()[0] || null;
    res.json({
      today,
      default_years: years,
      max_years: 5,
      earliest_data: earliest,
      years_available: earliest ? T.windowForYears(5, today).academic_years
        .filter(ay => Number(ay.slice(5)) >= Number(T.academicYearOf(earliest).slice(5))) : [],
      term_basis: 'Statutory early-years terms: Autumn 1 Sep – 31 Dec, Spring 1 Jan – 31 Mar, Summer 1 Apr – 31 Aug.',
      suppression: { min_group: S.MIN_GROUP },
      row_counts: {
        observations: e.observations, register_rows: e.register_rows,
        next_steps: e.next_steps, tracker_cells: e.tracker_cells,
      },
      sections: [
        { key: 'next-steps',   label: 'Next steps' },
        { key: 'tracker',      label: 'Framework tracker' },
        { key: 'settling',     label: 'Settling' },
        { key: 'observations', label: 'Observations' },
        { key: 'year-on-year', label: 'Year on year' },
      ],
    });
  } catch (e) {
    console.error('lookback /meta:', e.message);
    res.status(500).json({ error: 'meta_failed', message: e.message });
  }
});

// ── GET /report — the whole thing, or named sections ─────────────────────────
router.get('/report', guard, async (req, res) => {
  const db = getPool();
  try {
    const years = yearsOf(req) || await defaultYears(db);
    const report = await M.buildReport(db, { years, sections: sectionsOf(req) });
    report.notes = await loadNotes(db, reviewLabel(req, report));
    report.review_label = reviewLabel(req, report);
    // An inset-day report read is worth recording: it is the whole setting's
    // data, and /api/* audit already logs the call — this adds the window.
    recordAudit({ req, action: 'lookback.report', entity_type: 'lookback',
                  meta: { years, sections: sectionsOf(req) || 'all' } }).catch(() => {});
    res.json(report);
  } catch (e) {
    console.error('lookback /report:', e.message);
    res.status(500).json({ error: 'report_failed', message: e.message });
  }
});

// ── the discussion notes that feed the self-reflection workbook ─────────────
function reviewLabel(req, report) {
  const raw = String(req.query.review || '').trim().slice(0, 80);
  if (raw) return raw;
  return 'Inset ' + ((report && report.today) || T.todayYmd());
}

async function loadNotes(db, label) {
  try {
    const { rows } = await db.query(
      `SELECT chart_key, section_key, explain, will_try, owner_staff_id, updated_at
         FROM lookback_notes WHERE review_label = $1`, [label]);
    return Object.fromEntries(rows.map(r => [r.chart_key, r]));
  } catch (_) { return {}; }
}

router.get('/notes', guard, async (req, res) => {
  const db = getPool();
  try {
    const label = String(req.query.review || '').trim().slice(0, 80) || ('Inset ' + T.todayYmd());
    res.json({ review_label: label, notes: await loadNotes(db, label) });
  } catch (e) { res.status(500).json({ error: 'notes_failed', message: e.message }); }
});

// Which inset days have notes — so a later one can be opened again.
router.get('/reviews', guard, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT review_label, count(*)::int AS notes, max(updated_at) AS last_edited
         FROM lookback_notes GROUP BY review_label ORDER BY max(updated_at) DESC LIMIT 50`);
    res.json({ reviews: rows });
  } catch (e) { res.status(500).json({ error: 'reviews_failed', message: e.message }); }
});

router.post('/notes', guard, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const chartKey = String(b.chart_key || '').trim().slice(0, 120);
  if (!chartKey) return res.status(400).json({ error: 'chart_key_required' });
  const label = String(b.review_label || '').trim().slice(0, 80) || ('Inset ' + T.todayYmd());
  // The two prompts, and optionally who the action sits with. Length-capped:
  // these are discussion notes, not a document store.
  const explain  = b.explain  == null ? null : String(b.explain).slice(0, 4000);
  const willTry  = b.will_try == null ? null : String(b.will_try).slice(0, 4000);
  const owner    = Number(b.owner_staff_id) || null;
  try {
    const { rows } = await db.query(`
      INSERT INTO lookback_notes (chart_key, section_key, review_label, explain, will_try, owner_staff_id, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
      ON CONFLICT (chart_key, review_label) DO UPDATE
        SET explain        = COALESCE(EXCLUDED.explain,  lookback_notes.explain),
            will_try       = COALESCE(EXCLUDED.will_try, lookback_notes.will_try),
            owner_staff_id = EXCLUDED.owner_staff_id,
            section_key    = COALESCE(EXCLUDED.section_key, lookback_notes.section_key),
            updated_by     = EXCLUDED.updated_by,
            updated_at     = now()
      RETURNING chart_key, section_key, review_label, explain, will_try, owner_staff_id, updated_at`,
      [chartKey, String(b.section_key || '').slice(0, 60) || null, label, explain, willTry, owner, req.user.id]);
    recordAudit({ req, action: 'lookback.note', entity_type: 'lookback_note',
                  entity_id: chartKey, meta: { review_label: label } }).catch(() => {});
    res.json({ ok: true, note: rows[0] });
  } catch (e) {
    console.error('lookback POST /notes:', e.message);
    res.status(500).json({ error: 'note_save_failed', message: e.message });
  }
});

// ── GET /pack — the slide pack, as one self-contained HTML file ──────────────
// HTML rather than a PDF on purpose. Chromium cannot run in the Wren image
// (Alpine/musl, and puppeteer is a devDependency), and pdfkit — the house PDF
// path — draws boxes and text, not a legible chart deck. A single HTML file
// opens on the projector, prints to PDF from the browser at one slide per page,
// and needs no network: there is no <script src>, no font fetch and no API call
// in it.
router.get('/pack', guard, async (req, res) => {
  const db = getPool();
  try {
    const years = yearsOf(req) || await defaultYears(db);
    const report = await M.buildReport(db, { years, sections: sectionsOf(req) });
    const label = reviewLabel(req, report);
    report.review_label = label;
    report.notes = await loadNotes(db, label);
    const html = pack.renderPack(report, { theme: String(req.query.theme || 'light') === 'dark' ? 'dark' : 'light' });
    recordAudit({ req, action: 'lookback.pack', entity_type: 'lookback',
                  meta: { years, review_label: label } }).catch(() => {});
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="look-back-' + (report.today || 'report') + '.html"');
    res.send(html);
  } catch (e) {
    console.error('lookback /pack:', e.message);
    res.status(500).type('text/plain').send('Could not build the slide pack: ' + e.message);
  }
});

// ── GET /csv — the same aggregates, for anyone who wants to check the sums ───
router.get('/csv', guard, async (req, res) => {
  const db = getPool();
  try {
    const years = yearsOf(req) || await defaultYears(db);
    const report = await M.buildReport(db, { years, sections: sectionsOf(req) });
    const q = v => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [['section', 'chart', 'series', 'bucket', 'value', 'unit', 'children', 'p25', 'p75', 'rows'].join(',')];
    const push = (sec, chart, series, p) => lines.push([
      sec, chart.key, series || '', p.full || p.label,
      p.suppressed ? '' : (p.value == null ? '' : p.value),
      chart.unit || '', p.n, p.p25 == null ? '' : p.p25, p.p75 == null ? '' : p.p75,
      p.rows == null ? '' : p.rows,
    ].map(q).join(','));
    for (const sec of report.sections) {
      for (const chart of (sec.charts || [])) {
        if (chart.kind === 'multiline') {
          for (const ser of (chart.series || [])) for (const p of (ser.series || [])) push(sec.key, chart, ser.label, p);
        } else if (chart.kind === 'table') {
          for (const row of (chart.data || [])) {
            if (row.suppressed) { push(sec.key, chart, '', row); continue; }
            for (const m of (row.metrics || [])) push(sec.key, chart, m.label, { label: row.label, value: m.value, n: row.n });
          }
        } else {
          for (const p of (chart.data || [])) push(sec.key, chart, '', p);
        }
      }
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="look-back-' + report.today + '.csv"');
    res.send(lines.join('\n'));
  } catch (e) {
    console.error('lookback /csv:', e.message);
    res.status(500).type('text/plain').send('Could not build the CSV: ' + e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// b529 (2026-10-26) — SETTING TRENDS: the trends and the gaps across the whole
// setting at the end of a term, as opposed to the five look-back sections above,
// which answer "how have the children been progressing over years".
//
// Added to THIS router rather than a new one on purpose: the gate, the Roost
// allow-list entry, the PARENT_DENY entry and the suppression rule are already
// right here, and the page is the same page. Nothing above this line changed.
// ═════════════════════════════════════════════════════════════════════════════

const ST = require('../lib/setting-trends');
const STC = require('../lib/setting-trends-cards');

function termOf(req) {
  const raw = String(req.query.term || '').trim();
  return raw && /^[0-9]{4}-[0-9]{4}-T[1-3]$/.test(raw) ? raw : 'current';
}

// ── GET /trends — the whole analysis for one term ────────────────────────────
router.get('/trends', guard, async (req, res) => {
  const db = getPool();
  try {
    const trends = await ST.buildTrends(db, {
      term: termOf(req),
      compare: String(req.query.compare || '') !== 'false',
    });
    // Which terms can be asked for: every term from the first observation to
    // today, newest first, so the page's picker is not a guess.
    trends.terms_available = await termsAvailable(db);
    recordAudit({ req, action: 'lookback.trends', entity_type: 'lookback',
                  meta: { term: trends.term.key, flags: trends.flags.length } }).catch(() => {});
    res.json(trends);
  } catch (e) {
    console.error('lookback /trends:', e.message);
    res.status(500).json({ error: 'trends_failed', message: e.message });
  }
});

async function termsAvailable(db) {
  try {
    const { rows } = await db.query(`SELECT min(created_at)::date AS first FROM observations`);
    const first = T.ymd(rows[0] && rows[0].first) || T.todayYmd();
    return T.termSpine(first, T.todayYmd())
      .map(t => ({ key: t.key, label: t.label, start: t.start, end: t.end }))
      .reverse();
  } catch (_) { const t = T.termOf(T.todayYmd()); return [{ key: t.key, label: t.label, start: t.start, end: t.end }]; }
}

// ── GET /trends.csv — the grid and the flags, for anyone checking the sums ───
router.get('/trends.csv', guard, async (req, res) => {
  const db = getPool();
  try {
    const d = await ST.buildTrends(db, { term: termOf(req), compare: true });
    const q = v => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [];
    lines.push(['block', 'dimension', 'group', 'area', 'value', 'unit', 'children_evidenced', 'children'].join(','));
    for (const a of d.coverage.areas) {
      lines.push(['coverage', 'all', 'All children', a.area, a.suppressed ? '' : a.value, '%',
                  a.suppressed ? '' : a.children_evidenced, a.n].map(q).join(','));
    }
    for (const dim of d.grid.dimensions) {
      for (const b of dim.buckets) {
        const cells = (dim.cells.find(c => c.key === b.key) || {}).cells || [];
        d.grid.areas.forEach((a, i) => {
          const c = cells[i] || {};
          lines.push(['coverage', dim.label, b.label, a.label, c.suppressed ? '' : c.value, '%',
                      c.suppressed ? '' : c.children_evidenced, c.n].map(q).join(','));
        });
      }
    }
    if (d.comparison && d.comparison.available) {
      for (const a of d.comparison.areas) {
        lines.push(['previous term (' + d.comparison.term.label + ')', 'all', 'All children', a.area,
                    a.suppressed ? '' : a.value, '%', a.suppressed ? '' : a.children_evidenced, a.n].map(q).join(','));
      }
    }
    lines.push('');
    lines.push(['flag', 'severity', 'kind', 'title', 'detail'].join(','));
    for (const f of d.flags) lines.push([f.key, f.severity, f.kind, f.title, f.detail].map(q).join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="setting-trends-' + d.term.key + '.csv"');
    res.send(lines.join('\n'));
  } catch (e) {
    console.error('lookback /trends.csv:', e.message);
    res.status(500).type('text/plain').send('Could not build the CSV: ' + e.message);
  }
});

// ── POST /trends/cards — raise the flags onto the What-needs-me board ────────
// The same call the termly job makes (scripts/setting-trends-job.js), so a
// manager can do it on demand without waiting for the end of term. In-app only:
// a card on the board, and nothing sent anywhere.
router.post('/trends/cards', guard, async (req, res) => {
  const db = getPool();
  try {
    const trends = await ST.buildTrends(db, { term: termOf(req), compare: false });
    const result = await STC.raiseCards(db, trends, {
      staffId: req.user.id,
      dryRun: String((req.body || {}).dry_run || '') === 'true' || (req.body || {}).dry_run === true,
    });
    recordAudit({ req, action: 'lookback.trends.cards', entity_type: 'cockpit_card',
                  meta: { term: trends.term.key, raised: result.raised.length, skipped: result.skipped.length } }).catch(() => {});
    res.json(Object.assign({ ok: true, flags: trends.flags.length }, result));
  } catch (e) {
    console.error('lookback POST /trends/cards:', e.message);
    res.status(500).json({ error: 'cards_failed', message: e.message });
  }
});

module.exports = router;
