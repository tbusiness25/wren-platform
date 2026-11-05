'use strict';
/**
 * b311 — the signal registry.
 *
 * ── WHAT A SIGNAL IS ────────────────────────────────────────────────────────
 * A signal is one deterministic question, asked in SQL, with a yes/no answer.
 * It is a file. Adding a tenth signal is adding a file next to these nine and
 * nothing else — no registration list to update, no route to touch.
 *
 * There is deliberately NO general "look at everything and think of something"
 * pass. That is how a system like this starts guessing, and a system that
 * guesses about a nursery invents a member of staff who resigned.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 * Every file in this directory (except the underscore-prefixed helpers) exports:
 *
 *   key          string   stable id; the signal_state primary key. Never rename.
 *   label        string   how it reads on the Roost screen
 *   question     string   the SQL question in one line of English
 *   category     string   notification category — must be registered in
 *                         src/services/notification-categories.js
 *   priority     number   lower wins the daily cap first
 *   recipients   string   'all-managers' | 'dsl'
 *   link         string?  where the notification points
 *   defaults     object   thresholds + cooldown_hours + min_gap_hours
 *   evaluate(ctx) async   returns one of:
 *                           null                      — nothing to say (the success case)
 *                           { dormant, reason }       — cannot be evaluated here
 *                           { fingerprint, headline, facts, link?, containsChildData? }
 *
 * `headline` is the claim of record: a sentence built from the rows, that says
 * what was seen. The local model may only REPHRASE it (see phrasing.js) and can
 * never decide whether it is true.
 *
 * `fingerprint` is a stable string over the material facts. The runner uses it
 * to tell "the same thing is still true" (wait for the cooldown) from "the
 * numbers moved" (a shorter minimum gap applies).
 *
 * `facts` is what the notification is traceable back to: counts, ids and dates.
 * NEVER a child's name — see child-name-guard.js, which checks the sent text
 * against ladn.children on every single fire rather than trusting this comment.
 *
 * ── ctx ─────────────────────────────────────────────────────────────────────
 *   db        pg pool (search_path already ladn)
 *   today     'YYYY-MM-DD' in Europe/London — INJECTABLE, which is what makes
 *             every signal testable without mutating a single row
 *   now       Date
 *   cfg       merged defaults + per-signal overrides from signal_state.config
 *   setting   async (key, fallback) => string
 */

const fs = require('fs');
const path = require('path');

const REQUIRED = ['key', 'label', 'question', 'category', 'evaluate'];
const VALID_RECIPIENTS = new Set(['all-managers', 'dsl']);

let _cache = null;

function _loadOne(file) {
  const mod = require(path.join(__dirname, file));
  for (const f of REQUIRED) {
    if (!mod[f]) throw new Error(`signals/${file}: missing "${f}"`);
  }
  if (typeof mod.evaluate !== 'function') throw new Error(`signals/${file}: evaluate is not a function`);
  const recipients = mod.recipients || 'all-managers';
  if (!VALID_RECIPIENTS.has(recipients)) {
    throw new Error(`signals/${file}: unknown recipients "${recipients}"`);
  }
  return Object.assign({}, mod, {
    file,
    recipients,
    priority: Number.isFinite(mod.priority) ? mod.priority : 50,
    defaults: Object.assign({ cooldown_hours: 72, min_gap_hours: 24 }, mod.defaults || {}),
  });
}

/** Every signal, ordered by priority (the order the daily cap spends itself in). */
function all() {
  if (_cache) return _cache;
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.js'))
    .filter(f => !f.startsWith('_'))
    .filter(f => !['index.js', 'runner.js', 'phrasing.js', 'child-name-guard.js', 'nudge.js'].includes(f))
    .sort();
  const loaded = files.map(_loadOne);
  const seen = new Set();
  for (const s of loaded) {
    if (seen.has(s.key)) throw new Error(`signals: duplicate key "${s.key}"`);
    seen.add(s.key);
  }
  loaded.sort((a, b) => (a.priority - b.priority) || a.key.localeCompare(b.key));
  _cache = loaded;
  return _cache;
}

function byKey(key) {
  return all().find(s => s.key === key) || null;
}

/** Test hook — forget the cached registry (used by the b311 test harness). */
function _reset() { _cache = null; }

module.exports = { all, byKey, _reset, VALID_RECIPIENTS };
