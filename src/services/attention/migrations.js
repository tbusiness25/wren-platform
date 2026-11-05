'use strict';
/**
 * migrations.js — b232 collector. SQL that has been written but never run.
 *
 * Every build in this codebase leaves a `scripts/b<NNN>-*.sql` behind. Dev picks
 * them up because somebody applies them by hand to wren_dev; production only
 * gets them when Toby remembers. The gap between "the code is deployed" and "the
 * table it needs exists" is a 500 error waiting for the first person to open the
 * page, and nothing in the system currently notices it.
 *
 * So: parse each file for the objects it creates, then ask each database whether
 * they are there.
 *
 *   present in dev, missing in prod   RED    — the source that needs it is in the
 *                                              working tree. Host scripts in
 *                                              wren/scripts run from that tree on
 *                                              cron, so "dev-only" does not
 *                                              actually contain them.
 *   missing in both                   AMBER  — written, never applied anywhere.
 *   present in prod                   (omitted — nothing to say)
 *
 * ── WHAT IT READS FROM PROD ─────────────────────────────────────────────────
 * information_schema.tables and .columns. Object names, nothing else. No row is
 * selected from any ladn table in the production database by this file.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { classify } = require('./rag');

const SOURCE = 'migrations';
const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', 'scripts');

// ── parsing ─────────────────────────────────────────────────────────────────
// Deliberately blunt: CREATE TABLE and ADD COLUMN only. A regex is the right tool
// here because it is allowed to miss things — a missed object means one fewer
// card, never a wrong one.
const RE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ladn\.)?["']?([a-z0-9_]+)["']?/gi;
const RE_COL   = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ladn\.)?["']?([a-z0-9_]+)["']?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-z0-9_]+)["']?/gi;

function parseSql(text) {
  // Strip line comments so a commented-out CREATE TABLE is not counted.
  const body = text.replace(/^\s*--.*$/gm, '');
  const tables = new Set(), columns = new Set();
  let m;
  RE_TABLE.lastIndex = 0; while ((m = RE_TABLE.exec(body))) tables.add(m[1].toLowerCase());
  RE_COL.lastIndex = 0;   while ((m = RE_COL.exec(body)))   columns.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  return { tables, columns };
}

// ── database probes (schema only) ───────────────────────────────────────────
async function schemaOf(pool) {
  const { rows: t } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'ladn'`);
  const { rows: c } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'ladn'`);
  return {
    tables: new Set(t.map(r => r.table_name)),
    columns: new Set(c.map(r => `${r.table_name}.${r.column_name}`)),
  };
}

function prodPool() {
  return new Pool({
    host: process.env.ATTENTION_PROD_PG_HOST || process.env.PG_HOST || '127.0.0.1',
    port: parseInt(process.env.ATTENTION_PROD_PG_PORT || process.env.PG_PORT || '5434', 10),
    database: process.env.ATTENTION_PROD_PG_DB || 'wren',
    user: process.env.PG_USER || 'wren',
    password: process.env.PG_PASSWORD,
    max: 2,
    idleTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
}

async function collect() {
  let files;
  try {
    files = fs.readdirSync(SCRIPTS_DIR).filter(f => /^b\d+.*\.sql$/i.test(f)).sort();
  } catch (e) {
    return { ok: false, items: [], note: `scripts dir unreadable: ${e.message}` };
  }
  if (!files.length) return { ok: true, items: [] };

  const devPool = require('../../db/pool').getPool();
  const prodDb = process.env.ATTENTION_PROD_PG_DB || 'wren';
  if (prodDb === (process.env.PG_DB || 'wren')) {
    // Comparing a database with itself finds nothing missing and would let the
    // refresh close every real drift item as fixed. Same trap the crons
    // collector fell into with the container's own Alpine crontab.
    return { ok: false, items: [], note: `dev and prod both point at "${prodDb}" — refusing to compare a database with itself` };
  }

  const prod = prodPool();
  let dev, live;
  try {
    dev  = await schemaOf(devPool);
    live = await schemaOf(prod);
  } catch (e) {
    await prod.end().catch(() => {});
    // Cannot see one of the databases — say nothing rather than guess. ok:false
    // stops the refresh auto-resolving items this collector raised last time.
    return { ok: false, items: [], note: `schema probe failed: ${e.message}` };
  }
  await prod.end().catch(() => {});

  const items = [];
  for (const f of files) {
    let parsed;
    try { parsed = parseSql(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8')); }
    catch { continue; }
    if (!parsed.tables.size && !parsed.columns.size) continue;

    const missingProd = [
      ...[...parsed.tables].filter(t => !live.tables.has(t)).map(t => `table ${t}`),
      ...[...parsed.columns].filter(c => !live.columns.has(c) && live.tables.has(c.split('.')[0])).map(c => `column ${c}`),
    ];
    if (!missingProd.length) continue;

    const inDev = [
      ...[...parsed.tables].filter(t => dev.tables.has(t)),
      ...[...parsed.columns].filter(c => dev.columns.has(c)),
    ].length;

    const build = (f.match(/^b\d+/i) || ['?'])[0];
    const deployedInDev = inDev > 0;
    const c = classify({ schemaDrift: deployedInDev, blockedOnToby: true });

    items.push({
      source: SOURCE,
      source_key: f,
      title: `${build}: ${missingProd.length} database object${missingProd.length === 1 ? '' : 's'} missing from production`,
      detail: `\`scripts/${f}\` has not been applied to the production database. Missing: ${missingProd.slice(0, 8).join(', ')}`
            + `${missingProd.length > 8 ? ` and ${missingProd.length - 8} more` : ''}. `
            + (deployedInDev
                ? 'It IS applied on wren_dev, so the feature works there and will 500 on prod the moment the source is deployed.'
                : 'It has not been applied anywhere yet.'),
      why: c.why,
      rag: c.rag,
      category: 'deploy',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 5,
      action_url: '/admin/system/tech',
      evidence: { file: `scripts/${f}`, missing_in_prod: missingProd.slice(0, 40), applied_on_dev: deployedInDev },
      sort_hint: 4,
    });
  }

  return { ok: true, items };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect, _parseSql: parseSql };
