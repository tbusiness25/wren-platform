'use strict';
/*
 * b269 — Paperwork store background worker.
 *
 * WHY A TABLE AND NOT A PROMISE: b269 says "the browser must not block, and
 * closing the tab must not lose the job". An in-flight promise dies with the
 * container; a row in ladn.paperwork_jobs does not. Upload therefore writes the
 * file, writes the row, and returns 202 immediately — everything after that
 * happens here.
 *
 * Two stages per document:
 *   extract — text layer / OCR / docx. Local tooling only, no network.
 *   ai      — propose category, date, title, summary; receipts get a second call.
 *
 * They are separate rows so a working extraction is never re-run because the
 * Ascent was asleep. If the AI stage fails the document lands in the review list
 * flagged needs_ai, with its text intact and searchable, for a person to file by
 * hand. It is never sent to a cloud model and never dropped.
 *
 * Claiming uses FOR UPDATE SKIP LOCKED, so wren-ladn and wren-ladn-dev pointed at
 * the same database could not process the same file twice. (They are not — dev
 * is wren_dev — but the queue should not depend on that staying true.)
 *
 * Envs:
 *   PAPERWORK_WORKER_DISABLED   truthy → do not start at all
 *   PAPERWORK_WORKER_INTERVAL   seconds between polls (default 10)
 *   PAPERWORK_MAX_ATTEMPTS      give up after N tries (default 3)
 */

const { getPool } = require('../db/pool');
const pipeline = require('./paperwork-pipeline');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

function startPaperworkWorker({ interval = 10 } = {}) {
  if (process.env.PAPERWORK_WORKER_DISABLED) {
    console.log('[paperwork-worker] disabled by env');
    return;
  }
  const INTERVAL     = (parseInt(process.env.PAPERWORK_WORKER_INTERVAL, 10) || interval) * 1000;
  const MAX_ATTEMPTS = parseInt(process.env.PAPERWORK_MAX_ATTEMPTS, 10) || 3;

  let running = false;

  async function claimOne(db) {
    // One job at a time. OCR is CPU-bound and this box has six cores shared with
    // every other container — draining the whole queue in parallel would starve
    // the portals people are actually using.
    const { rows } = await db.query(`
      WITH claimed AS (
        SELECT id FROM ${SCHEMA()}.paperwork_jobs
         WHERE status = 'pending' AND run_after <= now()
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE ${SCHEMA()}.paperwork_jobs j
         SET status = 'running', started_at = now(), attempts = j.attempts + 1
        FROM claimed
       WHERE j.id = claimed.id
      RETURNING j.*`);
    return rows[0] || null;
  }

  async function finish(db, job, { ok, error }) {
    if (ok) {
      await db.query(
        `UPDATE ${SCHEMA()}.paperwork_jobs SET status='done', finished_at=now(), last_error=NULL WHERE id=$1`,
        [job.id]);
      return;
    }
    const dead = job.attempts >= MAX_ATTEMPTS;
    await db.query(
      `UPDATE ${SCHEMA()}.paperwork_jobs
          SET status = $2, last_error = $3, finished_at = CASE WHEN $2='failed' THEN now() ELSE NULL END,
              run_after = now() + ($4 || ' seconds')::interval
        WHERE id = $1`,
      [job.id, dead ? 'failed' : 'pending', String(error).slice(0, 2000), dead ? 0 : 60 * job.attempts]);
  }

  // ── Stage 1: get the words out ────────────────────────────────────────────
  async function runExtract(db, job) {
    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.paperwork_documents WHERE id=$1`, [job.document_id]);
    if (!doc) throw new Error(`document ${job.document_id} vanished`);

    await db.query(
      `UPDATE ${SCHEMA()}.paperwork_documents SET status='processing' WHERE id=$1 AND status='queued'`,
      [doc.id]);

    const r = await pipeline.extractText(doc.stored_path, doc.filename);

    await db.query(
      `UPDATE ${SCHEMA()}.paperwork_documents
          SET extracted_text=$2, extract_method=$3, extract_chars=$4,
              page_count=COALESCE($5, page_count), extract_error=$6
        WHERE id=$1`,
      [doc.id, r.text || null, r.method, (r.text || '').length, r.pageCount, r.error || null]);

    // Hand on to the AI stage whatever happened. Even with no text at all the
    // model gets the filename, which for "2026-04 Ealing yellow book.pdf" is
    // most of the answer.
    await db.query(
      `INSERT INTO ${SCHEMA()}.paperwork_jobs (document_id, stage) VALUES ($1, 'ai')`, [doc.id]);
  }

  // ── Stage 2: ask the Ascent where it goes ─────────────────────────────────
  async function runAi(db, job) {
    const { rows: [doc] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.paperwork_documents WHERE id=$1`, [job.document_id]);
    if (!doc) throw new Error(`document ${job.document_id} vanished`);

    const { rows: cats }   = await db.query(
      `SELECT key, label, description FROM ${SCHEMA()}.paperwork_categories ORDER BY sort_order`);
    const { rows: pinned } = await db.query(
      `SELECT category, subfolder FROM ${SCHEMA()}.paperwork_pinned_folders ORDER BY category, sort_order`);
    const { rows: seen }   = await db.query(
      `SELECT DISTINCT category, subfolder FROM ${SCHEMA()}.paperwork_documents
        WHERE subfolder IS NOT NULL AND deleted=false LIMIT 60`);

    let sug;
    try {
      sug = await pipeline.proposeFiling({
        text: doc.extracted_text, filename: doc.filename,
        categories: cats, pinned: pinned.concat(seen),
      });
    } catch (e) {
      // The Ascent is unreachable, asleep, or the model refused to produce JSON.
      // Queue is done with this document: store it un-summarised, mark needs_ai,
      // and let a person categorise by hand. NEVER a cloud fallback.
      await db.query(
        `UPDATE ${SCHEMA()}.paperwork_documents
            SET needs_ai=true, ai_error=$2,
                status = CASE WHEN status='filed' THEN status ELSE 'review' END,
                title = COALESCE(title, $3)
          WHERE id=$1`,
        [doc.id, String(e.message).slice(0, 500), niceTitleFrom(doc.filename)]);
      return; // job itself succeeded — it did the only correct thing available
    }

    // status is a CASE, not a literal: extraction and the AI call are separate
    // jobs and the AI one can still be queued when a person files the document
    // from the review list. Writing 'review' unconditionally un-filed it behind
    // their back — and because search only returns filed documents, the thing
    // they had just filed silently vanished from search. Found by
    // scripts/b269-verify.js §6.
    await db.query(
      `UPDATE ${SCHEMA()}.paperwork_documents
          SET ai_suggested=$2, ai_model=$3, ai_error=NULL, needs_ai=false,
              status = CASE WHEN status='filed' THEN status ELSE 'review' END
        WHERE id=$1`,
      [doc.id, JSON.stringify(sug), sug.model || pipeline.aiModel()]);

    // Receipts: the one extra step. Run it now so the review screen can show the
    // figures next to the scan, but never let a failed receipt parse fail the
    // filing proposal that already succeeded.
    const looksFinancial = sug.is_receipt === true || sug.category === 'finance';
    if (looksFinancial && (doc.extracted_text || '').trim()) {
      try {
        const rec = await pipeline.extractReceipt({ text: doc.extracted_text, filename: doc.filename });
        await db.query(
          `INSERT INTO ${SCHEMA()}.paperwork_receipts
             (document_id, supplier, receipt_date, total_amount, vat_amount, currency, ai_raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (document_id) DO UPDATE
             SET supplier=EXCLUDED.supplier, receipt_date=EXCLUDED.receipt_date,
                 total_amount=EXCLUDED.total_amount, vat_amount=EXCLUDED.vat_amount,
                 currency=EXCLUDED.currency, ai_raw=EXCLUDED.ai_raw, updated_at=now()
           WHERE ${SCHEMA()}.paperwork_receipts.confirmed = false`,
          [doc.id, rec.supplier, rec.receipt_date, rec.total_amount, rec.vat_amount,
           rec.currency, JSON.stringify(rec.raw)]);
      } catch (e) {
        console.error('[paperwork-worker] receipt parse:', e.message);
      }
    }
  }

  /** "2026-04-12 Ealing yellow book.pdf" → "2026 04 12 Ealing yellow book" */
  function niceTitleFrom(filename) {
    return String(filename || 'Untitled')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200) || 'Untitled';
  }

  async function tick() {
    if (running) return;
    running = true;
    const db = getPool();
    try {
      // Drain until empty, so a folder of 40 files does not take 400 seconds of
      // polling to start the fortieth.
      for (;;) {
        const job = await claimOne(db);
        if (!job) break;
        try {
          if (job.stage === 'extract') await runExtract(db, job);
          else                         await runAi(db, job);
          await finish(db, job, { ok: true });
        } catch (e) {
          console.error(`[paperwork-worker] job ${job.id} (${job.stage}):`, e.message);
          await finish(db, job, { ok: false, error: e.message });
          if (job.attempts >= MAX_ATTEMPTS) {
            // Out of retries. The file and its text are still there; a person
            // files it by hand from the review list.
            await db.query(
              `UPDATE ${SCHEMA()}.paperwork_documents
                  SET status = CASE WHEN status='filed' THEN status ELSE 'review' END,
                      needs_ai = true
                WHERE id=$1`, [job.document_id]);
          }
        }
      }
    } catch (e) {
      console.error('[paperwork-worker] tick:', e.message);
    } finally {
      running = false;
    }
  }

  const t = setInterval(tick, INTERVAL);
  if (t.unref) t.unref();
  setTimeout(tick, 3000).unref?.();
  console.log(`[paperwork-worker] started — every ${INTERVAL / 1000}s, model ${pipeline.aiModel()} @ ${pipeline.ollamaHost()}`);
  return { tick };
}

module.exports = { startPaperworkWorker };
