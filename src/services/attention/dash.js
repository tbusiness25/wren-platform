'use strict';
/**
 * dash.js — b232 collector. What is worth keeping from the dash on :8704.
 *
 * The dash was the previous attempt at this board and it went stale because it
 * had to be fed. Its `items` table is nevertheless a real record of work started
 * and dropped, which is exactly the ADHD failure mode this build is for, so the
 * useful rows come across before the container is stopped.
 *
 *   status='building'   AMBER   started, unfinished, and still yours
 *   status='forgotten'  AMBER   if priority is high or critical
 *                       GREEN   otherwise — a real record, not a demand
 *   status='live'       skipped — it is done
 *   status='scrapped'   skipped — it was decided against
 *
 * ── AFTER dash IS STOPPED ───────────────────────────────────────────────────
 * This returns ok:false with a note the moment dash-postgres stops answering.
 * That is deliberate: ok:false means the refresh does NOT auto-resolve the rows
 * it imported, so the ported items survive the retirement of the thing they came
 * from. The import happens once and then the collector goes quiet for good.
 *
 * Connection details come from DASH_DATABASE_URL, or the same host/port the dash
 * cron jobs use (127.0.0.1:5435). No credential is written into this file.
 */

const { Pool } = require('pg');
const { classify } = require('./rag');

const SOURCE = 'dash';

function dashPool() {
  if (process.env.DASH_DATABASE_URL) {
    return new Pool({ connectionString: process.env.DASH_DATABASE_URL, max: 2, connectionTimeoutMillis: 4000 });
  }
  return new Pool({
    host: process.env.DASH_PG_HOST || '127.0.0.1',
    port: parseInt(process.env.DASH_PG_PORT || '5435', 10),
    database: 'dash', user: 'dash',
    password: process.env.DASH_PG_PASSWORD,
    max: 2, connectionTimeoutMillis: 4000, statement_timeout: 10000,
  });
}

async function collect() {
  const pool = dashPool();
  let rows;
  try {
    ({ rows } = await pool.query(`
      SELECT id, title, description, status, priority, category, blocker, last_touched
        FROM items
       WHERE archived_at IS NULL AND status IN ('building','forgotten')
       ORDER BY status, priority NULLS LAST, id`));
  } catch (e) {
    await pool.end().catch(() => {});
    return { ok: false, items: [], note: `dash DB not reachable (retired?): ${e.message}` };
  }
  await pool.end().catch(() => {});

  const items = rows.map(r => {
    const hot = r.status === 'building' || ['high', 'critical'].includes(String(r.priority || '').toLowerCase());
    const c = classify(hot ? { blockedOnToby: true } : { informational: true, why: 'Started once, dropped, still on the record.' });
    return {
      source: SOURCE,
      source_key: `item-${r.id}`,
      title: `${r.status === 'building' ? 'Half-built' : 'Dropped'}: ${r.title}`,
      detail: [
        r.description ? String(r.description).slice(0, 400) : null,
        r.blocker ? `Blocked on: ${r.blocker}` : null,
        `Last touched ${r.last_touched ? new Date(r.last_touched).toISOString().slice(0, 10) : 'unknown'} — ported from the dash on :8704 before it was retired.`,
      ].filter(Boolean).join(' '),
      why: c.why,
      rag: c.rag,
      category: r.category || 'backlog',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: null,
      action_url: null,
      evidence: { dash_item_id: r.id, dash_status: r.status, priority: r.priority || null },
      sort_hint: r.status === 'building' ? 5 : 9,
    };
  });

  return { ok: true, items, note: `${items.length} items ported from dash` };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
