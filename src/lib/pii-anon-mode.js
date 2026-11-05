'use strict';
/**
 * pii-anon-mode.js — b402 (2026-10-06).
 *
 * The one helper every export/report route calls to decide whether this
 * particular request should come back anonymised, then does it.
 *
 *   const { maybeAnonymise } = require('../lib/pii-anon-mode');
 *   const rows = await maybeAnonymise(req, rawRows, { table: 'children' });
 *
 * PRECEDENCE
 *   1. ?anon=1 / ?anon=0 on the querystring, or { anon: true|false } in the body
 *      — an explicit request always wins, in either direction.
 *   2. otherwise, the edition setting `pii_anon_exports_default` in the plain
 *      key/value `settings` table ('on' | 'off', same convention as every other
 *      flag there, e.g. device_enforce_admin — see migrations/2026-10-06-b402-*).
 *      'off' by default for LADN.
 * The front-end toggle (public/js/wren-anon-toggle.js) remembers the viewer's own
 * last choice in localStorage and sends it as the explicit querystring flag, so
 * a personal preference never needs a server-side setting to take effect.
 */

const { getPool } = require('../db/pool');
const { anonymiseRows } = require('./anonymise');

const EXPORTS_KEY = 'pii_anon_exports_default';
const AI_KEY = 'pii_anon_ai_default';
const TTL_MS = 30000;

const cache = { exports: { at: 0, value: 'off' }, ai: { at: 0, value: 'on' } };

async function settingDefault(db, key, slot, fallback) {
  const now = Date.now();
  if (now - cache[slot].at < TTL_MS) return cache[slot].value;
  let value = fallback;
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
    if (rows[0] && typeof rows[0].value === 'string') value = rows[0].value;
  } catch { /* settings row may not exist yet — fall back */ }
  cache[slot] = { at: now, value };
  return value;
}

const exportsDefault = (db) => settingDefault(db, EXPORTS_KEY, 'exports', 'off');
const aiDefault = (db) => settingDefault(db, AI_KEY, 'ai', 'on');

function explicitFlag(req) {
  if (req.query && Object.prototype.hasOwnProperty.call(req.query, 'anon')) {
    return ['1', 'true', 'yes'].includes(String(req.query.anon).toLowerCase());
  }
  if (req.body && typeof req.body === 'object' && Object.prototype.hasOwnProperty.call(req.body, 'anon')) {
    return req.body.anon === true || ['1', 'true', 'yes'].includes(String(req.body.anon).toLowerCase());
  }
  return undefined; // not specified either way
}

/**
 * The precedence decision alone, with no row shape assumed — for a caller
 * (e.g. report-builder.js) whose rows aren't plain objects and needs to pick
 * its own anonymising adapter.
 * @param {import('express').Request} req
 * @returns {Promise<boolean>}
 */
async function shouldAnonymise(req) {
  const explicit = explicitFlag(req);
  if (explicit !== undefined) return explicit;
  try { return (await exportsDefault(getPool())) === 'on'; } catch { return false; }
}

/**
 * @param {import('express').Request} req
 * @param {object[]} rows
 * @param {object} opts  passed through to anonymiseRows ({table, columns?, ...})
 * @returns {Promise<object[]>} rows, anonymised or not
 */
async function maybeAnonymise(req, rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  if (!(await shouldAnonymise(req))) return rows;
  return anonymiseRows(rows, opts);
}

module.exports = { maybeAnonymise, shouldAnonymise, exportsDefault, aiDefault, EXPORTS_KEY, AI_KEY };
