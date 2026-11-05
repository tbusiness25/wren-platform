'use strict';
/**
 * query-layer.js — b348: the only door between a chat model and the database.
 *
 * What goes in:  a metric NAME and typed arguments (or something the layer refuses).
 * What comes out: a few aggregate rows — counts, sums — labelled by room / month / status / age
 *                 band, with small groups withheld. Never a row about a person.
 *
 * FOUR INDEPENDENT WALLS (any one of them stops a leak; all four have to fail for one to happen)
 *   1. Allow-list   the model can only name a metric in metrics.js; there is no SQL argument.
 *   2. Static guard every metric's SQL passes sql-guard.js at load; one that fails is disabled.
 *   3. Read-only    each run is BEGIN READ ONLY with a statement timeout, rolled back after.
 *   4. Result guard whatever comes back is checked against the declared columns, capped in rows,
 *                   every label is run through the redaction lexicon, and small cells are withheld.
 *
 * request() is the entry point for anything that is NOT a plain "run this metric" — raw SQL, a
 * table name, "list the rows". It never runs any of them; it classifies the ask with the static
 * guard and returns a specific refusal, which is what the chat shows the person and what gets
 * logged.
 */

const { METRICS, SNIPPETS } = require('./metrics');
const { guardSql } = require('./sql-guard');
const { PROTECTED_TABLE_RE, BANNED_COLUMNS, MIN_CELL, LIMITS } = require('./policy');

const REFUSAL_HELP = 'This chat can only see counts and totals — never an individual child, parent, observation, diary entry, ' +
  'medicine record, safeguarding note or message. Ask for a number ("how many…", "how has … changed by month"). ' +
  'For a person\'s record use Roost, or the on-site Wren AI.';

const expand = (sql) => sql.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, n) => SNIPPETS[n]);

// ── the registry, validated once at load ────────────────────────────────────
const REGISTRY = new Map();

function vetSnippets() {
  const bad = [];
  for (const [name, text] of Object.entries(SNIPPETS)) {
    const ids = (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).map((x) => x.toLowerCase());
    const banned = ids.filter((x) => BANNED_COLUMNS.has(x) && x !== 'date_of_birth');
    if (/[;]|\b(select|from|insert|update|delete|drop)\b/i.test(text) || banned.length) bad.push(name);
  }
  return bad;
}
const BAD_SNIPPETS = new Set(vetSnippets());

for (const m of METRICS) {
  const g = guardSql(m.sql, { snippets: Object.keys(SNIPPETS).filter((s) => !BAD_SNIPPETS.has(s)) });
  let ok = g.ok, code = g.code || null, detail = g.detail || null;
  if (ok) {
    const declared = m.columns.map((c) => c.name);
    if (JSON.stringify(declared) !== JSON.stringify(g.columns)) { ok = false; code = 'columns_mismatch'; detail = 'declared [' + declared + '] but the SQL returns [' + g.columns + ']'; }
    const maxParam = Math.max(0, ...[...m.sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1])));
    if (ok && maxParam !== Object.keys(m.params || {}).length) { ok = false; code = 'params_mismatch'; detail = 'SQL uses $' + maxParam + ' but ' + Object.keys(m.params || {}).length + ' params are declared'; }
  }
  REGISTRY.set(m.id, { metric: m, sql: expand(m.sql).replace(/\s+/g, ' ').trim(), ok, code, detail, tables: g.tables || [] });
}

/** What the registry looks like — used by the status endpoint and the verify script. */
function registryStatus() {
  return [...REGISTRY.values()].map((e) => ({ id: e.metric.id, ok: e.ok, code: e.code, detail: e.detail,
    sensitivity: e.metric.sensitivity, protected_tables: [...new Set(e.tables.filter((t) => t.class === 'protected').map((t) => t.name))] }));
}

const refused = (code, message, extra) => Object.assign({ ok: false, refused: code, message }, extra || {});

// ── parameters ──────────────────────────────────────────────────────────────
function bindParams(metric, given) {
  const spec = metric.params || {};
  const g = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
  for (const k of Object.keys(g)) {
    if (!(k in spec)) return { error: refused('unknown_param', '"' + k + '" is not a parameter of ' + metric.id + '. ' +
      (Object.keys(spec).length ? 'Its parameters: ' + Object.keys(spec).join(', ') + '.' : 'It takes no parameters.')) };
  }
  const values = [];
  for (const [name, p] of Object.entries(spec)) {
    let v = g[name];
    if (v === undefined || v === null || v === '') v = p.default;
    if (p.type === 'int') {
      if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) v = parseInt(v, 10);
      if (!Number.isInteger(v)) return { error: refused('bad_param', name + ' must be a whole number') };
      if (v < p.min || v > p.max) return { error: refused('param_out_of_range', name + ' must be between ' + p.min + ' and ' + p.max) };
    } else if (p.type === 'enum') {
      if (!p.values.includes(v)) return { error: refused('bad_param', name + ' must be one of: ' + p.values.join(', ')) };
    } else return { error: refused('bad_param', 'unsupported parameter type') };
    values.push(v);
  }
  return { values };
}

// ── the result guard ────────────────────────────────────────────────────────
function assertAggregateResult(metric, fields, rows, lexicon) {
  if (!lexicon) return refused('no_lexicon', 'The redaction lexicon is not available, so no result is released.');
  const declared = metric.columns.map((c) => c.name);
  if (JSON.stringify(fields) !== JSON.stringify(declared)) return refused('unexpected_columns', 'The query returned columns that are not declared for ' + metric.id + '.');
  if (rows.length > LIMITS.maxRows) return refused('too_many_rows', metric.id + ' returned ' + rows.length + ' rows; the cap is ' + LIMITS.maxRows + '.');

  const min = MIN_CELL[metric.sensitivity] || 0;
  const cellCols = metric.columns.filter((c) => c.cell).map((c) => c.name);
  let withheld = 0;
  const out = [];
  for (const raw of rows) {
    const row = {};
    let cellMasked = false;
    for (const col of metric.columns) {
      const v = raw[col.name];
      if (col.kind === 'dimension') {
        const label = v == null ? 'unknown' : String(v);
        if (label.length > LIMITS.maxLabelChars) return refused('label_too_long', 'A label in ' + metric.id + ' is not a short label — result withheld.');
        if (lexicon.verify(label).length) return refused('label_identifies_person', 'A label in ' + metric.id + ' matched a name or identifier — result withheld.');
        row[col.name] = label;
      } else {
        const n = typeof v === 'number' ? v : (v == null ? 0 : Number(v));
        if (!Number.isFinite(n)) return refused('non_numeric', 'A measure in ' + metric.id + ' was not a number — result withheld.');
        row[col.name] = n;
      }
    }
    if (min > 0) {
      for (const col of metric.columns) {
        if (col.kind === 'measure' && col.agg === 'count' && row[col.name] >= 1 && row[col.name] < min) {
          if (col.cell) cellMasked = true;
        }
      }
      for (const col of metric.columns) {
        if (col.kind !== 'measure') continue;
        const n = row[col.name];
        const small = col.agg === 'count' && n >= 1 && n < min;
        const followsCell = col.agg !== 'count' && cellCols.length && cellMasked;
        if (small || followsCell) { row[col.name] = '<' + min; withheld++; }
      }
    }
    out.push(row);
  }
  return { ok: true, columns: metric.columns, rows: out, withheld, min_cell: min };
}

// ── running a metric ────────────────────────────────────────────────────────
async function runMetric(db, id, params, { lexicon } = {}) {
  const entry = REGISTRY.get(String(id));
  if (!entry) return refused('not_allowlisted', '"' + id + '" is not an available metric. ' + REFUSAL_HELP, { available: [...REGISTRY.keys()] });
  if (!entry.ok) return refused('metric_disabled', entry.metric.id + ' is switched off: it failed the static guard (' + entry.code + ').');
  const b = bindParams(entry.metric, params);
  if (b.error) return b.error;

  const pooled = typeof db.connect === 'function' && typeof db.release !== 'function';
  const client = pooled ? await db.connect() : db;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = ' + Number(LIMITS.statementTimeoutMs));
    const res = await client.query(entry.sql, b.values);
    await client.query('ROLLBACK');
    const guarded = assertAggregateResult(entry.metric, res.fields.map((f) => f.name), res.rows, lexicon);
    if (!guarded.ok) return guarded;
    return Object.assign(guarded, { ok: true, metric: entry.metric.id, title: entry.metric.title, params: params || {}, as_of: new Date().toISOString() });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection may already be gone */ }
    return refused('query_failed', entry.metric.id + ' could not be run (' + (e.code || 'error') + ').');
  } finally {
    if (pooled) client.release();
  }
}

/**
 * request(db, spec) — anything a caller (or a model) asks for. Only {metric, params} is ever run.
 * Everything else is classified and refused with a reason.
 */
async function request(db, spec, ctx = {}) {
  if (!spec || typeof spec !== 'object') return refused('bad_request', 'Nothing to run. ' + REFUSAL_HELP);

  if (spec.sql != null) {
    const g = guardSql(String(spec.sql));
    return refused(g.ok ? 'raw_sql_not_accepted' : g.code,
      g.ok ? 'Raw SQL is never run from the chat, even when it would pass the static guard. ' + REFUSAL_HELP
           : 'Refused (' + g.code + '): ' + g.detail + '. ' + REFUSAL_HELP,
      { classification: { static_guard: g.ok ? 'pass' : g.code, detail: g.detail || null, tables: (g.tables || []).map((t) => t.name + ':' + t.class) } });
  }
  const wantsRows = spec.table || spec.rows || spec.list || spec.select || spec.columns || spec.child || spec.child_id || spec.name;
  if (wantsRows && !spec.metric) {
    const table = spec.table ? String(spec.table).toLowerCase().replace(/^.*\./, '') : null;
    return refused('row_level', 'A row-level request' + (table ? ' for "' + table + '"' : '') + ' was refused. ' + REFUSAL_HELP,
      { classification: { table, table_class: table ? (PROTECTED_TABLE_RE.test(table) ? 'protected' : 'unclassified') : null } });
  }
  if (spec.metric) return runMetric(db, spec.metric, spec.params, ctx);
  return refused('bad_request', 'Nothing to run. ' + REFUSAL_HELP);
}

// ── what the model and the UI are shown ─────────────────────────────────────
function catalogue() {
  return [...REGISTRY.values()].filter((e) => e.ok).map((e) => ({
    id: e.metric.id, group: e.metric.group, title: e.metric.title, description: e.metric.description,
    sensitivity: e.metric.sensitivity,
    params: Object.fromEntries(Object.entries(e.metric.params || {}).map(([k, p]) => [k, { type: p.type, min: p.min, max: p.max, default: p.default, values: p.values, description: p.description }])),
    columns: e.metric.columns.map((c) => ({ name: c.name, kind: c.kind, unit: c.unit || null, description: c.description })),
  }));
}

/** Gemini functionDeclarations: one function per metric, so argument names and ranges are enforced by the API too. */
function functionDeclarations() {
  return catalogue().map((m) => {
    const props = {};
    for (const [k, p] of Object.entries(m.params)) {
      props[k] = p.type === 'int'
        ? { type: 'INTEGER', description: p.description + ' (' + p.min + '–' + p.max + ', default ' + p.default + ')' }
        : { type: 'STRING', enum: p.values, description: p.description };
    }
    const d = { name: m.id, description: m.description + (m.sensitivity !== 'normal' ? ' [small groups withheld]' : '') };
    if (Object.keys(props).length) d.parameters = { type: 'OBJECT', properties: props };
    return d;
  });
}

/** Compact, model-readable form of a released result. */
function forModel(result) {
  return {
    metric: result.metric, as_of: result.as_of.slice(0, 16).replace('T', ' ') + ' UTC (live)',
    columns: result.columns.map((c) => c.name + (c.unit ? ' (' + c.unit + ')' : '')),
    rows: result.rows.map((r) => result.columns.map((c) => r[c.name])),
    note: result.withheld ? result.withheld + ' small figure(s) withheld and shown as "<' + result.min_cell + '" to protect individuals.' : undefined,
  };
}

module.exports = { runMetric, request, catalogue, functionDeclarations, forModel, registryStatus, assertAggregateResult, bindParams, REFUSAL_HELP, REGISTRY };
