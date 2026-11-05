'use strict';
/**
 * eyfs-digest.js — b361 (2026-09-29)
 *
 * Builds the Staff Reading Corner's weekly digest: gather the public EYFS feeds,
 * shortlist what is about early years, have the LOCAL model write each one up in
 * three or four plain sentences plus "what it means for us", store it, and raise
 * one in-Wren notification.
 *
 * Called from scripts/b361-weekly-digest.js (a HOST script — see the NOTES on
 * why this is not an in-process cron). Nothing here is mounted on the server.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────────
 * Three separate things make a second run in the same week a no-op:
 *   1. staff_reading_digests.week_start is UNIQUE, so there is one row per week
 *      and the second run finds it rather than making another.
 *   2. staff_reading_items.url_hash is UNIQUE, so an article already in the
 *      corner — from this week's run, last week's, or a manager publishing a
 *      staff suggestion — is skipped, not duplicated.
 *   3. The notification is raised only when notified_at is null, inside the same
 *      statement that sets it.
 * Re-running therefore costs a handful of HTTP requests and adds whatever is
 * genuinely new. That is the behaviour you want from something on a cron that
 * might fire twice after a reboot.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 * src/lib/sovereign-model.js, which refuses to talk to anything that is not a
 * private/Tailscale IP literal. It is overkill for a public news article — there
 * is nothing confidential in a gov.uk press release — but routing this through
 * the same client as everything else means there is exactly ONE place in Wren
 * that can reach a model, and no second code path for somebody to point at a
 * cloud endpoint later "because it's only public data".
 *
 * If the Ascent is down the run still completes: items are stored with the
 * publisher's own feed summary, model = null, and the digest says so. A week
 * with plain feed summaries is better than no digest, and a row whose `model`
 * column is null is visibly a row nobody wrote about.
 *
 * ── NO EMAIL ────────────────────────────────────────────────────────────────
 * The notification category 'reading_corner_digest' is deliberately NOT in
 * notification-dispatcher.js's EMAIL_ALLOWED_CATEGORIES, so the allowlist's
 * fail-closed default blocks the email channel. Nothing in this file constructs
 * a message, an address or a transport.
 */

const news = require('../lib/eyfs-news');

const CATEGORY = 'reading_corner_digest';
const WIDENING_WINDOWS = [null, 21, 35];   // null = whatever settings says; then widen
const SUMMARY_TIMEOUT_MS = 90000;

// ── settings ────────────────────────────────────────────────────────────────
const csv = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

async function loadConfig(q) {
  const { rows } = await q(
    `SELECT key, value FROM settings WHERE key IN
       ('reading_corner_topics','reading_corner_exclude','reading_corner_min_items',
        'reading_corner_max_items','reading_corner_lookback_days')`);
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const int = (k, d) => { const n = parseInt(s[k], 10); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    topics:   s.reading_corner_topics  ? csv(s.reading_corner_topics)  : news.DEFAULT_TOPICS,
    excludes: s.reading_corner_exclude ? csv(s.reading_corner_exclude) : news.DEFAULT_EXCLUDES,
    min:      int('reading_corner_min_items', 5),
    max:      int('reading_corner_max_items', 12),
    lookback: int('reading_corner_lookback_days', 14),
  };
}

async function loadSources(q) {
  const { rows } = await q(
    `SELECT key, name, publisher, feed_url, site_url, kind, enabled, note
       FROM staff_reading_sources ORDER BY key`);
  return rows;
}

/** The Monday of the week a date falls in, as YYYY-MM-DD. */
function weekStart(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7;                 // 0 = Monday
  t.setUTCDate(t.getUTCDate() - dow);
  return t.toISOString().slice(0, 10);
}

// ── the model ───────────────────────────────────────────────────────────────
const SYSTEM = [
  'You write a weekly reading round-up for the staff of a small day nursery in Ealing, west London.',
  'Your readers are early years practitioners and room leaders, not policy analysts. Several are apprentices.',
  'Write in plain British English. Short sentences. No jargon you would not say out loud to a colleague.',
  'Never invent a fact, a figure, a date or a quotation. If the text you are given does not say something, do not say it either.',
  'Never mention a child, a parent or a family. You are not given any and there are none to mention.',
].join(' ');

function itemPrompt(item) {
  return [
    'Here is one item from an early years news feed.',
    '',
    `TITLE: ${item.title}`,
    `PUBLISHER: ${item.publisher || item.source_name}`,
    item.published_on ? `PUBLISHED: ${item.published_on}` : '',
    '',
    'WHAT THE FEED SAYS:',
    (item.raw_summary || '(the feed gave no summary — work from the title alone and say less rather than guessing)'),
    '',
    'Reply with a single JSON object and nothing else:',
    '{',
    '  "summary": "3 to 4 sentences saying what this is, in plain words.",',
    '  "what_it_means": "1 or 2 sentences: what, if anything, a practitioner at our nursery should do or notice. If the honest answer is that it does not change anything for us, say that.",',
    '  "confident": true or false',
    '}',
    '',
    'Set "confident" to false if the feed text was too thin to write a fair summary from. Do not pad it out.',
  ].filter(Boolean).join('\n');
}

/**
 * Summarise one item with the local model.
 * @returns {Promise<{summary:string|null, what_it_means:string|null, model:string|null, error:string|null}>}
 */
async function summariseItem(sov, item) {
  try {
    const r = await sov.generateJSON({
      system: SYSTEM,
      prompt: itemPrompt(item),
      temperature: 0.2,
      numPredict: 400,
      timeoutMs: SUMMARY_TIMEOUT_MS,
    });
    if (!r.ok) return { summary: null, what_it_means: null, model: null, error: r.error };
    const v = r.value || {};
    const summary = typeof v.summary === 'string' ? v.summary.trim() : '';
    const means = typeof v.what_it_means === 'string' ? v.what_it_means.trim() : '';
    if (!summary) return { summary: null, what_it_means: null, model: null, error: 'model returned no summary' };
    return {
      summary: news.clip(summary, 1200),
      what_it_means: means ? news.clip(means, 600) : null,
      model: sov.MODEL,
      confident: v.confident !== false,
      error: null,
    };
  } catch (e) {
    return { summary: null, what_it_means: null, model: null, error: e.message };
  }
}

// ── the run ─────────────────────────────────────────────────────────────────
/**
 * @param {(sql:string, params?:any[]) => Promise<{rows:any[]}>} q
 * @param {object} opts
 * @param {boolean} [opts.dryRun]     fetch and summarise, write nothing
 * @param {boolean} [opts.noModel]    skip the model, keep the publisher's summary
 * @param {boolean} [opts.publish]    publish + notify (default: build as a draft)
 * @param {Date}    [opts.today]
 * @param {function} [opts.log]
 * @param {function} [opts.notify]    (category, recipientType, recipientId, title, body, options)
 * @returns {Promise<object>} the run report
 */
async function run(q, opts = {}) {
  const log = opts.log || (() => {});
  const today = opts.today || new Date();
  const week = weekStart(today);
  const dryRun = !!opts.dryRun;

  const cfg = await loadConfig(q);
  const sources = await loadSources(q);
  log(`week starting ${week}; ${sources.filter(s => s.kind === 'rss' && s.enabled).length} fetchable sources of ${sources.length} registered`);

  // ── 1. gather ─────────────────────────────────────────────────────────────
  const g = await news.gather(sources);
  log(`fetched: ${g.ok.length} ok, ${g.failed.length} failed, ${g.skipped.length} not fetchable — ${g.items.length} candidate items`);
  for (const f of g.failed) log(`  ! ${f.name}: ${f.error}`);

  // ── 2. shortlist, widening the window rather than publishing a thin week ──
  let picked = [], usedWindow = cfg.lookback;
  for (const w of WIDENING_WINDOWS) {
    usedWindow = w == null ? cfg.lookback : w;
    picked = news.shortlist(g.items, {
      topics: cfg.topics, excludes: cfg.excludes,
      lookbackDays: usedWindow, max: cfg.max, today,
    });
    log(`  ${usedWindow}-day window → ${picked.length} relevant`);
    if (picked.length >= cfg.min) break;
  }

  // ── 3. which of these are already in the corner ───────────────────────────
  const hashes = picked.map(p => p.url_hash);
  let known = new Set();
  if (hashes.length) {
    const { rows } = await q(`SELECT url_hash FROM staff_reading_items WHERE url_hash = ANY($1::text[])`, [hashes]);
    known = new Set(rows.map(r => r.url_hash));
  }
  const fresh = picked.filter(p => !known.has(p.url_hash));
  log(`${fresh.length} new, ${picked.length - fresh.length} already in the corner`);

  // ── 4. summarise ──────────────────────────────────────────────────────────
  let sov = null, modelName = null, modelError = null;
  if (!opts.noModel && fresh.length) {
    try {
      sov = require('../lib/sovereign-model');
      const probe = await sov.assertSovereign();
      modelName = probe.model;
      log(`local model: ${probe.model} on ${probe.host}`);
    } catch (e) {
      sov = null;
      modelError = e.message;
      log(`! local model unavailable, keeping the publishers' own summaries — ${e.message}`);
    }
  }

  const written = [];
  for (const item of fresh) {
    let summary = item.raw_summary ? news.clip(item.raw_summary, 900) : null;
    let means = null, model = null;
    if (sov) {
      const s = await summariseItem(sov, item);
      if (s.summary) { summary = s.summary; means = s.what_it_means; model = s.model; }
      else log(`  ! could not summarise "${news.clip(item.title, 60)}": ${s.error}`);
    }
    written.push(Object.assign({}, item, { summary, what_it_means: means, model }));
  }

  const report = {
    week_start: week, dry_run: dryRun,
    window_days: usedWindow,
    candidates: g.items.length,
    relevant: picked.length,
    new_items: fresh.length,
    already_known: picked.length - fresh.length,
    sources_ok: g.ok,
    sources_failed: g.failed,
    sources_skipped: g.skipped,
    per_source: g.perSource,
    model: modelName,
    model_error: modelError,
    items: written.map(w => ({
      title: w.title, url: w.url, source: w.source_name, published_on: w.published_on,
      topics: w.topics, summarised: !!w.model,
      summary: w.summary, what_it_means: w.what_it_means,
    })),
  };

  if (dryRun) { log('DRY RUN — nothing written'); return report; }

  // ── 5. write ──────────────────────────────────────────────────────────────
  const runNote = `window ${usedWindow}d · ${g.items.length} candidates · ${picked.length} relevant · ${fresh.length} new`
                + (modelError ? ` · model unavailable (${news.clip(modelError, 120)})` : '');

  const dig = await q(`
    INSERT INTO staff_reading_digests (week_start, status, built_at, model, sources_ok, sources_failed, run_note)
    VALUES ($1::date, 'draft', now(), $2, $3::text[], $4::jsonb, $5)
    ON CONFLICT (week_start) DO UPDATE
      SET built_at = now(),
          model          = COALESCE(EXCLUDED.model, staff_reading_digests.model),
          sources_ok     = EXCLUDED.sources_ok,
          sources_failed = EXCLUDED.sources_failed,
          run_note       = EXCLUDED.run_note,
          updated_at     = now()
    RETURNING id, status, notified_at`,
    [week, modelName, g.ok, JSON.stringify(g.failed), runNote]);
  const digestId = dig.rows[0].id;
  report.digest_id = digestId;

  let inserted = 0;
  for (const w of written) {
    const r = await q(`
      INSERT INTO staff_reading_items
        (kind, title, url, url_hash, source_key, source_name, publisher, published_on,
         summary, what_it_means, topics, digest_id, model, status)
      VALUES ('news',$1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10::text[],$11,$12,'published')
      ON CONFLICT (url_hash) WHERE url_hash IS NOT NULL DO NOTHING
      RETURNING id`,
      [w.title, w.url, w.url_hash, w.source_key, w.source_name, w.publisher, w.published_on,
       w.summary, w.what_it_means, w.topics || [], digestId, w.model]);
    if (r.rows.length) inserted++;
  }
  report.inserted = inserted;

  const cnt = await q(`SELECT count(*)::int AS n FROM staff_reading_items WHERE digest_id = $1 AND status = 'published'`, [digestId]);
  await q(`UPDATE staff_reading_digests SET item_count = $2, updated_at = now() WHERE id = $1`, [digestId, cnt.rows[0].n]);
  report.item_count = cnt.rows[0].n;
  log(`digest ${digestId}: ${inserted} item(s) written, ${cnt.rows[0].n} in the week`);

  // ── 6. publish + notify ───────────────────────────────────────────────────
  if (opts.publish) {
    const pub = await q(`
      UPDATE staff_reading_digests
         SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now()
       WHERE id = $1 AND item_count > 0
       RETURNING id, notified_at, item_count`, [digestId]);
    report.published = pub.rows.length > 0;
    if (pub.rows.length && !pub.rows[0].notified_at && opts.notify) {
      // The guard is the UPDATE itself: only the run that flips notified_at from
      // null sends anything, so two runs racing cannot notify twice.
      const claim = await q(
        `UPDATE staff_reading_digests SET notified_at = now() WHERE id = $1 AND notified_at IS NULL RETURNING id`, [digestId]);
      if (claim.rows.length) {
        const { rows: staff } = await q(`SELECT id FROM staff WHERE COALESCE(is_active, true) ORDER BY id`);
        const n = pub.rows[0].item_count;
        // AWAITED, one at a time. The dispatcher's own notify() is
        // fire-and-forget (it returns undefined and swallows the promise), and
        // a cron script that calls it then exits reports "notified 28" while
        // writing nothing — which is exactly what the first run of this build
        // did. Callers pass notifyAsync; anything that returns a promise is
        // awaited here, and the count below is of dispatches that finished.
        let sent = 0, failed = 0;
        for (const s of staff) {
          try {
            await opts.notify(CATEGORY, 'staff', s.id,
              'This week in early years',
              `${n} thing${n === 1 ? '' : 's'} worth a read — Reading Corner.`,
              { link: '/ey/reading-corner' });
            sent++;
          } catch (e) { failed++; if (failed === 1) log(`  ! notify failed: ${e.message}`); }
        }
        report.notified = sent;
        report.notify_failed = failed;
        log(`notified ${sent} staff${failed ? `, ${failed} failed` : ''} (in-Wren only; this category is not emailable)`);
      }
    }
  }

  return report;
}

module.exports = { run, weekStart, loadConfig, loadSources, summariseItem, CATEGORY, SYSTEM };
