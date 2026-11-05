'use strict';
/**
 * reading-room-scan.js — b352 (2026-09-22)
 *
 * Walks the two wren-docs trees and keeps `ladn.reading_room_items` in step with them. One row per
 * document; the file is the source and this only points at it, snapshots its text so it can be shown in
 * place, and leaves the reader's own ticks alone.
 *
 * Runs from two places with the same code:
 *   - the reading-room route, on load (when the trees are reachable from that process), and
 *   - scripts/b352-reading-room-scan.js on the host (which is how the trees are reachable today: neither
 *     container mounts them — see the NOTES).
 *
 * ── WHAT IS LISTED ─────────────────────────────────────────────────────────────────────────────
 * Every regular file with a text extension (.md .html .htm .txt .csv) that is not in a noise folder and
 * is not a backup. Everything else is COUNTED, by reason, so "N files on disk" always adds up:
 *   listed + withheld + excluded(by reason) = every regular file `find -type f` sees.
 *
 * ── WHAT IS NEVER LISTED ───────────────────────────────────────────────────────────────────────
 * A document that contains a child's full name, a parent/carer's full name, or a family email address.
 * It gets a row (so the count is honest) with the PATH ONLY and a reason code — no title, no summary, no
 * text, and never the value that matched. The check runs here, on the host/in the container, against the
 * live children/contacts tables; nothing leaves the machine.
 *
 * ── LIMITS OF THAT CHECK (also in the NOTES) ───────────────────────────────────────────────────
 * It matches full names and email addresses. A document that says only "Ollie's mum" is not caught. The
 * brief is that Wren's own analyses hold no child data; this is the net under that promise, not a
 * substitute for it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── configuration ─────────────────────────────────────────────────────────────────────────────
const TEXT_EXT = new Set(['.md', '.html', '.htm', '.txt', '.csv']);
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;     // over this: listed, but "too large to show in place"

// Folders that are not documents to read. Matched on the directory NAME at any depth.
const NOISE_DIRS = new Set([
  'node_modules', '__pycache__', 'backups', 'cf-backups', 'policy-backups', 'vapi-backups',
  'assets', 'scans-raw', 'metabase-dashboards',
  'eylog-digests', 'imports',           // digests/exports of EyLog data — data, not analysis, and child-level
]);
// A closed project. Cyber Essentials was submitted 2026-06-11 and Toby has said never to raise it again,
// so its folder never becomes an unread pile. One line to remove if that ever changes.
const CLOSED_DIRS = new Set(['cse']);

const BACKUP_RE = /(\.bak($|[-._])|\.bak-|~$|\.tmp$|\.swp$|\.orig$|\.pre-)/i;
const NON_TEXT_GROUPS = [
  ['images',                        /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i],
  ['not readable in place (pdf, docx, pptx, xlsx)', /\.(pdf|docx?|pptx?|xlsx?|odt|ods)$/i],
  ['code, config and data files',   /\.(js|mjs|cjs|py|pyc|sql|json|ya?ml|sh|toml|ini|env|log|xml)$/i],
  ['archives',                      /\.(gz|tgz|zip|tar|7z|bz2)$/i],
];

// ── roots ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Where the two trees are, from this process. READING_ROOM_ROOTS overrides:
 *   READING_ROOM_ROOTS="canonical=/x/wren-docs;repo=/y/wren-docs"
 */
function resolveRoots(env = process.env) {
  const out = [];
  if (env.READING_ROOM_ROOTS) {
    for (const part of String(env.READING_ROOM_ROOTS).split(';')) {
      const [tree, dir] = part.split('=');
      if (tree && dir) out.push({ tree: tree.trim(), dir: dir.trim() });
    }
  } else {
    out.push({ tree: 'canonical', dir: ['/app-docs', '/app/wren-docs'].find(isDir) || '/app-docs' });
    out.push({ tree: 'repo',      dir: ['/app/wren-docs', '/app/wren-docs-repo'].find(isDir) || '/app/wren-docs' });
  }
  return out.map(r => ({ ...r, reachable: isDir(r.dir) }));
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// ── the walk ──────────────────────────────────────────────────────────────────────────────────
function newExcluded() { return {}; }
function bump(map, reason, n = 1) { map[reason] = (map[reason] || 0) + n; }

/** Count regular files under a directory we are not going to read. */
function countFiles(dir) {
  let n = 0;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) n += countFiles(p);
    else if (e.isFile()) n++;
  }
  return n;
}

/**
 * @returns {{files: {rel:string,abs:string,bytes:number,mtimeMs:number,ext:string}[], excluded: Object<string,number>, onDisk:number}}
 *   `onDisk` is every regular file under the root, listed or not — what `find <root> -type f` prints.
 */
function walk(root) {
  const files = [], excluded = newExcluded();
  let onDisk = 0;
  (function rec(dir, relDir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isSymbolicLink()) { continue; }                        // never followed; `find -type f` skips them too
      if (e.isDirectory()) {
        const hidden = e.name.startsWith('.');
        if (CLOSED_DIRS.has(e.name)) { const n = countFiles(abs); onDisk += n; bump(excluded, 'a closed project (Cyber Essentials)', n); continue; }
        if (hidden || NOISE_DIRS.has(e.name)) { const n = countFiles(abs); onDisk += n; bump(excluded, 'noise folders (backups, assets, raw scans, data exports)', n); continue; }
        rec(abs, rel);
        continue;
      }
      if (!e.isFile()) continue;
      onDisk++;
      let st; try { st = fs.statSync(abs); } catch { bump(excluded, 'unreadable'); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (BACKUP_RE.test(e.name)) { bump(excluded, 'backup copies'); continue; }
      if (!TEXT_EXT.has(ext)) {
        const g = NON_TEXT_GROUPS.find(([, re]) => re.test(e.name));
        bump(excluded, g ? g[0] : 'other file types');
        continue;
      }
      files.push({ rel, abs, bytes: st.size, mtimeMs: st.mtimeMs, ext });
    }
  })(root, '');
  return { files, excluded, onDisk };
}

// ── classification ────────────────────────────────────────────────────────────────────────────
const REFERENCE_DIRS = new Set([
  'manuals', 'guides', 'hr', 'cctv', 'cutover', 'onboarding', 'newsletters', 'letters', 'kitchen', 'curriculum',
  'terms', 'marketing', 'customers', 'outreach', 'licensing', 'parents', 'sen', 'staff-guides', 'reference',
  'runbooks', 'phones', 'ia', 'gov-corpus', 'public-release', 'integrations', 'build-history', 'policy', 'policies',
  'gdpr', 'compliance', 'backlog',
]);

/** kind from the path alone: analysis | audit | research | decision | qa | reference | other */
function classify(rel) {
  const low = rel.toLowerCase();
  const segs = low.split('/');
  const base = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);
  if (dirs.includes('decisions')) return 'decision';               // the decision-record folder in both trees
  if (dirs.includes('qa') || dirs.some(d => d.startsWith('sweep-')) || /(bughunt|walk|sweep|(^|[-_])q0\d[-_])/.test(base)) return 'qa';
  if (dirs.includes('security') || /(audit|scan|readiness|pen-?test|dpia)/.test(base)) return 'audit';
  if (dirs.includes('research') || /(research|competitor|teardown|market|sizing|landscape|sourcing)/.test(base)) return 'research';
  if (dirs.includes('analysis') || /(analysis|overstaff|qualification-cost|parity|gap|insights?|comparison|estimate|forecast|fee-restructure|inventory|review|design)/.test(base)) return 'analysis';
  if (dirs.some(d => REFERENCE_DIRS.has(d))) return 'reference';
  return 'other';
}

// ── reading the text ──────────────────────────────────────────────────────────────────────────
function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }
function isBinary(buf) { const n = Math.min(buf.length, 4096); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }

function htmlToText(h) {
  return String(h)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
function mdPlain(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function clip(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—(]+$/, '') + '…';
}
function humanise(name) {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(\d{4}) (\d{2}) (\d{2}) /, '$1-$2-$3 — ');
}

function extractTitle(rel, ext, text) {
  const base = rel.split('/').pop();
  if (ext === '.md') {
    const m = text.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
    if (m) { const t = mdPlain(m[1]); if (t) return clip(t, 160); }
  } else if (ext === '.html' || ext === '.htm') {
    const t = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (t) { const s = htmlToText(t[1]); if (s) return clip(s, 160); }
  } else if (ext === '.txt') {
    const first = text.split('\n').map(l => l.trim()).find(Boolean);
    if (first && first.length <= 120) return clip(mdPlain(first), 160);
  }
  return clip(humanise(base), 160);
}

/** One honest line saying what the document is — taken from the document, never written for it. */
function extractSummary(rel, ext, text, title) {
  if (ext === '.csv') {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const cols = (lines[0] || '').split(',').map(c => c.trim().replace(/^"|"$/g, '')).filter(Boolean);
    return clip(`A table of ${Math.max(0, lines.length - 1)} rows. Columns: ${cols.slice(0, 8).join(', ')}${cols.length > 8 ? '…' : ''}.`, 220);
  }
  if (ext === '.html' || ext === '.htm') {
    const p = text.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const s = p ? htmlToText(p[1]) : htmlToText(text).slice(0, 400);
    return s.length >= 30 ? clip(s, 220) : clip(title, 220);
  }
  const lines = text.split(/\r?\n/);
  let inFence = false;
  const prose = [];
  const heads = [];
  const bullets = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (/^```/.test(l)) { inFence = !inFence; continue; }
    if (inFence || !l) continue;
    if (/^#{1,6}\s/.test(l)) { const h = mdPlain(l.replace(/^#{1,6}\s+/, '')); if (h && h !== title) heads.push(h); continue; }
    if (/^[|>]/.test(l) || /^-{3,}$|^={3,}$/.test(l)) continue;
    if (/^([-*+]|\d+[.)])\s+/.test(l)) { bullets.push(mdPlain(l.replace(/^([-*+]|\d+[.)])\s+/, ''))); continue; }
    if (/^\*\*[^*]+:\*\*\s*\S/.test(l) && l.length < 60) continue;   // "**Status:** draft"-style front matter
    const t = mdPlain(l);
    if (t.length >= 40) prose.push(t);
  }
  if (prose.length) return clip(prose[0], 220);
  const h2 = heads.slice(0, 4);
  if (h2.length >= 2) return clip('Covers: ' + h2.join(' · '), 220);
  if (bullets.length && bullets[0].length >= 25) return clip(bullets[0], 220);
  if (h2.length === 1) return clip('Covers: ' + h2[0], 220);
  return clip(title, 220);
}

function extractDate(rel, text, mtimeMs) {
  const base = rel;
  const iso = (y, m, d) => {
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    return (dt.getUTCFullYear() === +y && dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d) ? `${y}-${m}-${d}` : null;
  };
  let m = base.match(/(20\d{2})[-_](\d{2})[-_](\d{2})/);
  if (m) { const v = iso(m[1], m[2], m[3]); if (v) return v; }
  m = base.match(/(20\d{2})[-_](0[1-9]|1[0-2])(?!\d)/);
  if (m) return `${m[1]}-${m[2]}-01`;
  m = String(text).slice(0, 800).match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) { const v = iso(m[1], m[2], m[3]); if (v) return v; }
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

/**
 * "decision", "options" or "recommend" anywhere in it → it probably asks for a decision. The brief's own
 * rule, applied literally; a person flips it in one tap. Two carve-outs: a record of a decision ALREADY
 * made (the decisions/ folder) and reference material are for information by definition.
 */
const DECISION_RE = /\b(decisions?|options?|recommend(?:ation|ations|ed|s)?)\b/i;
function guessNeedsDecision(kind, text) {
  if (kind === 'decision' || kind === 'reference') return false;
  return DECISION_RE.test(text);
}

// ── the personal-data guard ───────────────────────────────────────────────────────────────────
const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
function normName(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, ' ').trim(); }
function tokens(s) { return normName(s).split(' ').filter(Boolean); }

/**
 * @param {(sql:string)=>Promise<{rows:any[]}>} query  bound to the ladn schema
 * @returns {{check:(text:string)=>{hit:boolean,reason:string|null}, size:{names:number,emails:number}}}
 */
async function buildGuard(query) {
  const names = new Set(), emails = new Set();
  const addName = (...parts) => {
    const t = tokens(parts.filter(Boolean).join(' '));
    if (t.length >= 2 && t.length <= 4 && t.join('').length >= 6 && t.every(x => x.length >= 2)) names.add(t.join(' '));
  };
  const addEmail = e => { const v = String(e || '').trim().toLowerCase(); if (v.includes('@')) emails.add(v); };

  const safe = async sql => { try { return (await query(sql)).rows; } catch (e) { if (e.code === '42P01' || e.code === '42703') return []; throw e; } };
  for (const r of await safe(`SELECT first_name, last_name, preferred_forename, preferred_surname, preferred_name,
                                      parent_1_name, parent_2_name, emergency_contact_1_name, emergency_contact_2_name,
                                      parent_1_email, parent_2_email, primary_contact_email FROM children`)) {
    addName(r.first_name, r.last_name); addName(r.preferred_forename, r.preferred_surname); addName(r.preferred_name, r.last_name);
    addName(r.parent_1_name); addName(r.parent_2_name); addName(r.emergency_contact_1_name); addName(r.emergency_contact_2_name);
    addEmail(r.parent_1_email); addEmail(r.parent_2_email); addEmail(r.primary_contact_email);
  }
  // contacts holds families AND a few business contacts; only those linked to a child are family.
  for (const r of await safe(`SELECT full_name, primary_email FROM contacts WHERE child_ids IS NOT NULL AND cardinality(child_ids) > 0`)) {
    addName(r.full_name); addEmail(r.primary_email);
  }
  // A staff member who is also a parent appears in the family tables under their own name. Their name is in
  // half of Wren's analyses ("Toby", "the deputy"…) and it is not what this guard is for: withholding a document
  // because it names the manager would empty the reading room. Their CHILD's name is still a hit on its own.
  for (const r of await safe(`SELECT first_name, last_name, preferred_name FROM staff`)) {
    for (const n of [tokens(`${r.first_name || ''} ${r.last_name || ''}`).join(' '), tokens(`${r.preferred_name || ''} ${r.last_name || ''}`).join(' ')]) names.delete(n);
  }
  // Addresses the nursery itself owns are not a family's, whoever happens to be on the contact row.
  for (const e of [...emails]) if (/@(example-nursery\.co\.uk|getwren\.co\.uk)$/.test(e)) emails.delete(e);
  const nameLens = new Set([...names].map(n => n.split(' ').length));

  function check(text) {
    const t = String(text || '');
    const found = t.match(EMAIL_RE);
    if (found) for (const e of found) if (emails.has(e.toLowerCase())) return { hit: true, reason: 'family_email' };
    if (names.size) {
      const words = tokens(t);
      for (const n of nameLens) {
        for (let i = 0; i + n <= words.length; i++) {
          if (names.has(words.slice(i, i + n).join(' '))) return { hit: true, reason: 'family_name' };
        }
      }
    }
    return { hit: false, reason: null };
  }
  return { check, size: { names: names.size, emails: emails.size } };
}

// ── the sync ──────────────────────────────────────────────────────────────────────────────────
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Bring reading_room_items in step with the trees. Never deletes a row and never touches a tick.
 * @param {(sql:string, params?:any[])=>Promise<{rows:any[], rowCount:number}>} query  bound to the ladn schema
 * @param {{roots?:object[], force?:boolean, log?:(s:string)=>void}} opts
 */
async function scan(query, opts = {}) {
  const roots = opts.roots || resolveRoots();
  const log = opts.log || (() => {});
  const reachable = roots.filter(r => r.reachable);
  const result = { ok: reachable.length > 0, roots: roots.map(r => ({ tree: r.tree, reachable: r.reachable })), trees: {}, started: new Date().toISOString() };
  if (!reachable.length) { result.note = 'No document folder is reachable from this process.'; return result; }

  const existing = new Map();
  for (const r of (await query(`SELECT id, tree, rel_path, sha256, bytes, EXTRACT(EPOCH FROM file_mtime)*1000 AS mtime_ms,
                                       withheld, missing_since FROM reading_room_items`)).rows) {
    existing.set(r.tree + ' ' + r.rel_path, r);
  }

  let guard = null;
  const getGuard = async () => guard || (guard = await buildGuard(query));

  for (const root of reachable) {
    const t = { onDisk: 0, listed: 0, withheld: 0, excluded: {}, added: 0, changed: 0, unchanged: 0, missing: 0, tooLarge: 0 };
    const w = walk(root.dir);
    t.onDisk = w.onDisk; t.excluded = w.excluded;
    const seen = [];

    for (const f of w.files) {
      seen.push(f.rel);
      const key = root.tree + ' ' + f.rel;
      const prev = existing.get(key);
      // Unchanged on disk (size + mtime) and not previously missing: nothing to read, nothing to write but last_seen.
      if (!opts.force && prev && Number(prev.bytes) === f.bytes && Math.abs(Number(prev.mtime_ms) - f.mtimeMs) < 1500 && !prev.missing_since) {
        t.unchanged++; if (prev.withheld) t.withheld++; else t.listed++;
        continue;
      }
      const kind = classify(f.rel);
      let buf; try { buf = fs.readFileSync(f.abs); } catch { bump(t.excluded, 'unreadable'); continue; }
      if (isBinary(buf)) { bump(t.excluded, 'not text (binary content)'); continue; }
      const digest = sha(buf);
      const tooLarge = f.bytes > MAX_SNAPSHOT_BYTES;
      const text = tooLarge ? '' : stripBom(buf.toString('utf8'));
      const g = tooLarge ? { hit: false } : (await getGuard()).check(text);
      const mtimeIso = new Date(f.mtimeMs).toISOString();

      let row;
      if (g.hit) {
        row = { title: clip(humanise(f.rel.split('/').pop()), 160), kind, summary: null, content: null, date: extractDate(f.rel, '', f.mtimeMs),
                needsDecision: false, withheld: true, reason: g.reason };
        t.withheld++;
      } else {
        const title = extractTitle(f.rel, f.ext, text);
        row = { title, kind,
                summary: tooLarge ? `Too large to show in place (${(f.bytes / 1048576).toFixed(1)} MB).` : extractSummary(f.rel, f.ext, text, title),
                content: tooLarge ? null : text, date: extractDate(f.rel, text, f.mtimeMs),
                needsDecision: tooLarge ? false : guessNeedsDecision(kind, text), withheld: false, reason: null };
        t.listed++; if (tooLarge) t.tooLarge++;
      }
      const fmt = f.ext === '.htm' ? 'html' : f.ext.slice(1);
      const changedHash = prev && prev.sha256 && prev.sha256 !== digest;
      await query(`
        INSERT INTO reading_room_items
          (tree, rel_path, title, kind, format, summary, bytes, sha256, doc_date, file_mtime, content_text,
           needs_decision, needs_decision_auto, withheld, withheld_reason, first_seen_at, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14, now(), now())
        ON CONFLICT (tree, rel_path) DO UPDATE SET
          title = EXCLUDED.title, kind = EXCLUDED.kind, format = EXCLUDED.format, summary = EXCLUDED.summary,
          bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, doc_date = EXCLUDED.doc_date, file_mtime = EXCLUDED.file_mtime,
          content_text = EXCLUDED.content_text,
          needs_decision_auto = EXCLUDED.needs_decision_auto,
          needs_decision = CASE WHEN reading_room_items.needs_decision_locked THEN reading_room_items.needs_decision ELSE EXCLUDED.needs_decision END,
          withheld = EXCLUDED.withheld, withheld_reason = EXCLUDED.withheld_reason,
          content_changed_at = CASE WHEN reading_room_items.sha256 IS DISTINCT FROM EXCLUDED.sha256 AND reading_room_items.sha256 IS NOT NULL
                                    THEN now() ELSE reading_room_items.content_changed_at END,
          missing_since = NULL, last_seen_at = now()`,
        [root.tree, f.rel, row.title, row.kind, fmt, row.summary, f.bytes, digest, row.date, mtimeIso, row.content,
         row.needsDecision, row.withheld, row.reason]);
      if (prev) t.changed++; else t.added++;
      if (changedHash) log(`  changed: ${root.tree}/${f.rel}`);
    }

    // Anything we hold that is no longer on disk keeps its row and its ticks; it is just marked.
    const gone = await query(
      `UPDATE reading_room_items SET missing_since = COALESCE(missing_since, now())
        WHERE tree = $1 AND missing_since IS NULL AND NOT (rel_path = ANY($2::text[]))`, [root.tree, seen]);
    t.missing = gone.rowCount || 0;
    result.trees[root.tree] = t;
  }

  result.finished = new Date().toISOString();
  // Counts only. A failed insert (the table not there yet) must never fail the scan itself.
  try {
    const slim = { at: result.finished, trees: Object.fromEntries(Object.entries(result.trees).map(([k, t]) => [k, {
      onDisk: t.onDisk, listed: t.listed, withheld: t.withheld, excluded: t.excluded, added: t.added, changed: t.changed, missing: t.missing }])) };
    await query(`INSERT INTO reading_room_scans (source, result) VALUES ($1, $2::jsonb)`, [opts.source || 'host', JSON.stringify(slim)]);
  } catch (e) { if (e.code !== '42P01') log('  (could not record the scan: ' + e.message + ')'); }
  return result;
}

module.exports = {
  scan, resolveRoots, walk, classify, extractTitle, extractSummary, extractDate, guessNeedsDecision, buildGuard,
  TEXT_EXT, NOISE_DIRS, CLOSED_DIRS, MAX_SNAPSHOT_BYTES, htmlToText, mdPlain,
};
