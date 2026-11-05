'use strict';
/**
 * sql-guard.js — b348: decides whether a piece of SQL is allowed to exist at all.
 *
 * The chat never runs SQL a model wrote — the model calls NAMED metrics (metrics.js) and the
 * SQL behind each is written by us. So this guard has two jobs:
 *
 *   1. VALIDATE OUR OWN REGISTRY. Every metric's SQL is run through guardSql() when the module
 *      loads and in the verify script. A metric that fails is switched off (fail closed), so a
 *      future edit that accidentally selects a name or drops a GROUP BY cannot ship quietly.
 *   2. REFUSE ANYTHING ELSE, WITH A REASON. request() in query-layer.js hands any raw SQL, table
 *      or "list the rows" ask to guardSql() to classify — and then refuses it regardless. The
 *      classification is what makes the refusal specific ("touches children, not aggregated")
 *      rather than a bare 403.
 *
 * It is a HEURISTIC, not a SQL parser, and it is deliberately blunt: it would rather reject a
 * harmless query than admit a leaky one. The runtime result guard (assertAggregateResult) is
 * the backstop for anything a heuristic misses.
 *
 * RULES (each has a code the refusal reports)
 *   not_select          must be a single SELECT / WITH … SELECT; no ; no DML/DDL; no pg_* / catalog
 *   dollar_quoting      no $$ / $tag$ quoting (a way to hide text from this scan)
 *   select_star         no *, no alias.*  (count(*) is fine)
 *   banned_column       no column that names a person, place or personal record, anywhere
 *   raw_value_function  no MIN/MAX/string_agg/array_agg/… — they hand a raw value back
 *   window_function     no OVER (…) — it puts a per-row value beside an aggregate
 *   unclassified_table  every relation must be classified protected or open in policy.js
 *   row_level           a select block over a protected table with no aggregate in it
 *   ungrouped_select    a non-aggregate select item with no GROUP BY
 *   per_entity_grouping GROUP BY / a dimension on an id that names a person (child_id, id, staff_id…)
 */

const { PROTECTED_TABLE_RE, OPEN_TABLES, BANNED_COLUMNS, RAW_VALUE_FUNCTIONS, SAFE_ID_COLUMNS } = require('./policy');

const AGG_RE = /\b(count|sum|avg)\s*\(/i;
const SET_RETURNING_OK = new Set(['generate_series']);
const FORBIDDEN_RE = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|vacuum|listen|notify|reset|execute|lock|refresh|into|merge|do|set|intersect|except|lateral)\b/i;
const CATALOG_RE = /\b(pg_\w+|information_schema|pg_catalog|dblink\w*|lo_\w+|set_config|current_setting|txid_\w+)\b/i;
const MASK = '\u0001';   // stands in for a comma inside a nested (…)

const refuse = (code, detail) => ({ ok: false, code, detail: detail || null });

function clean(sql) {
  let s = String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  if (/\$[A-Za-z_]\w*\$|\$\$/.test(s)) return { error: refuse('dollar_quoting', 'dollar-quoted strings are not allowed') };
  s = s.replace(/'(?:[^']|'')*'/g, "''");            // string literals -> ''
  s = s.replace(/"([^"]*)"/g, '$1');                 // "quoted identifiers" -> bare, so a banned column cannot hide in quotes
  return { sql: s.trim().replace(/;\s*$/, '') };
}

/** Split `text` into the top-level text of a block, with each nested (select …) returned as a sub-block. */
function toBlocks(text) {
  const root = { parts: [], subs: [] };
  const stack = [root];
  let cur = root;
  const open = [];
  for (const ch of text) {
    if (ch === '(') { const b = { parts: [], subs: [], parent: cur }; stack.push(b); cur = b; open.push(b); continue; }
    if (ch === ')') {
      const b = stack.pop(); cur = stack[stack.length - 1] || root; open.pop();
      const inner = b.parts.join('');
      if (/^\s*(select|with)\b/i.test(inner)) { cur.subs.push({ text: inner, subs: b.subs }); cur.parts.push('(§)'); }
      else { cur.subs.push(...b.subs); cur.parts.push('(' + inner.replace(/,/g, MASK) + ')'); }
      continue;
    }
    cur.parts.push(ch);
  }
  return { text: root.parts.join(''), subs: root.subs };
}

function stripAggregateCalls(expr) {
  let s = expr;
  for (let guard = 0; guard < 50; guard++) {
    const m = AGG_RE.exec(s);
    if (!m) break;
    let i = m.index + m[0].length, depth = 1;
    while (i < s.length && depth > 0) { if (s[i] === '(') depth++; else if (s[i] === ')') depth--; i++; }
    s = s.slice(0, m.index) + ' ' + s.slice(i);
  }
  return s;
}

const idents = (s) => (String(s).match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).map((x) => x.toLowerCase());
const isLiteral = (e) => e.replace(/''/g, '').replace(/::\s*[a-z_]+(\(\d+(,\d+)?\))?/gi, '').replace(/[\d.\s()+\-*/]/g, '') === '';
const isPerEntityId = (id) => (id === 'id' || /_id$/.test(id)) && !SAFE_ID_COLUMNS.has(id);

function analyseBlock(block, ctes, out) {
  const branches = block.text.split(/\bunion(?:\s+all)?\b/i);
  for (const branch of branches) {
    const at = branch.search(/\bselect\b/i);
    if (at < 0) return refuse('not_select', 'no SELECT in a block');
    const m = /^select\s+(?:distinct\s+)?([\s\S]*?)\s+from\s+([\s\S]*)$/i.exec(branch.slice(at).trim());
    if (!m) return refuse('not_select', 'a SELECT without a FROM');
    const list = m[1];
    const rest = m[2];
    const fromPart = rest.split(/\b(?:where|group\s+by|having|order\s+by|limit|offset|window)\b/i)[0];
    const gm = /\bgroup\s+by\s+([\s\S]*?)(?=\bhaving\b|\border\s+by\b|\blimit\b|\boffset\b|$)/i.exec(rest);
    const groupBy = gm ? gm[1] : '';

    // relations at THIS level
    let touchesProtected = false;
    const re = /(?:^|\bjoin\b|,)\s*([A-Za-z_][\w.]*)/gi;
    let rm;
    while ((rm = re.exec(fromPart))) {
      const bare = rm[1].split('.').pop().toLowerCase();
      if (ctes.has(bare) || SET_RETURNING_OK.has(bare)) continue;
      if (PROTECTED_TABLE_RE.test(bare)) { out.tables.push({ name: bare, class: 'protected' }); touchesProtected = true; }
      else if (OPEN_TABLES.includes(bare)) out.tables.push({ name: bare, class: 'open' });
      else return refuse('unclassified_table', bare + ' is not classified protected or open in policy.js');
    }

    // select list
    const items = list.split(',').map((x) => x.trim()).filter(Boolean);
    let anyAgg = false, anyPlain = false;
    const aliases = [];
    for (const item of items) {
      const am = /\s+as\s+([A-Za-z_]\w*)\s*$/i.exec(item);
      const expr = am ? item.slice(0, am.index) : item;
      aliases.push(am ? am[1].toLowerCase() : null);
      if (AGG_RE.test(expr)) {
        anyAgg = true;
        const dim = stripAggregateCalls(expr);
        for (const id of idents(dim)) if (isPerEntityId(id)) return refuse('per_entity_grouping', id + ' in a select item outside an aggregate');
      } else if (isLiteral(expr)) {
        continue;                                    // 'Mon', 1, 'x'::text — a constant is not a dimension
      } else {
        anyPlain = true;
        for (const id of idents(expr)) if (isPerEntityId(id)) return refuse('per_entity_grouping', id + ' would give one row per person');
      }
    }
    if (out.aliases === null) out.aliases = aliases;
    if (touchesProtected && !anyAgg) return refuse('row_level', 'reads a protected table (' + out.tables.filter((t) => t.class === 'protected').map((t) => t.name).join(', ') + ') without aggregating');
    // A block over ONLY open tables / CTEs (whose own blocks are checked) may select plain columns;
    // one that reads a protected table must group everything it does not aggregate.
    if (anyPlain && touchesProtected && !/\S/.test(groupBy)) return refuse('ungrouped_select', 'a non-aggregate select item over a protected table with no GROUP BY');
    for (const id of idents(groupBy)) if (isPerEntityId(id)) return refuse('per_entity_grouping', 'GROUP BY ' + id);
    if (anyAgg) out.aggregates++;
  }
  for (const sub of block.subs) {
    const r = analyseBlock(sub, ctes, out);
    if (r) return r;
  }
  return null;
}

/**
 * guardSql(sql, { snippets }) -> { ok:true, tables, columns, aggregates } | { ok:false, code, detail }
 * `snippets` is the set of {{names}} the template may use; they are masked before the scan
 * (their own text is vetted separately — see metrics.js).
 */
function guardSql(sql, { snippets = [] } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) return refuse('not_select', 'empty');
  let text = sql;
  const used = [...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((x) => x[1]);
  for (const u of used) if (!snippets.includes(u)) return refuse('unknown_snippet', u);
  text = text.replace(/\{\{\s*[a-z_]+\s*\}\}/g, '__snippet__');

  const c = clean(text);
  if (c.error) return c.error;
  const s = c.sql;
  if (s.includes(';')) return refuse('not_select', 'more than one statement');
  if (!/^\s*(select|with)\b/i.test(s)) return refuse('not_select', 'must start with SELECT or WITH');
  const forb = FORBIDDEN_RE.exec(s);
  if (forb) return refuse('not_select', 'keyword not allowed: ' + forb[1].toLowerCase());
  const cat = CATALOG_RE.exec(s);
  if (cat) return refuse('not_select', 'catalog / system function not allowed: ' + cat[1].toLowerCase());

  const noCountStar = s.replace(/\bcount\s*\(\s*\*\s*\)/gi, 'count(1)');
  if (/\bselect\s+(?:distinct\s+)?\*/i.test(noCountStar) || /,\s*\*/.test(noCountStar) || /\.\*/.test(noCountStar)) return refuse('select_star', '* would return every column');

  const ids = idents(s);
  for (const id of ids) if (BANNED_COLUMNS.has(id)) return refuse('banned_column', id);
  for (const f of RAW_VALUE_FUNCTIONS) if (new RegExp('\\b' + f + '\\s*\\(', 'i').test(s)) return refuse('raw_value_function', f + '()');
  if (/\bover\s*\(/i.test(s)) return refuse('window_function', 'OVER (…) is not allowed');

  const ctes = new Set([...s.matchAll(/\b([A-Za-z_]\w*)\s+as\s*\(/gi)].map((x) => x[1].toLowerCase()));
  const tree = toBlocks(s);
  const out = { tables: [], aliases: null, aggregates: 0 };
  const r = analyseBlock({ text: tree.text, subs: tree.subs }, ctes, out);
  if (r) return r;
  if (out.aggregates === 0) return refuse('row_level', 'no aggregate anywhere in the statement');
  return { ok: true, tables: out.tables, columns: out.aliases || [], aggregates: out.aggregates };
}

module.exports = { guardSql, stripAggregateCalls };
