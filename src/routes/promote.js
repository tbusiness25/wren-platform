'use strict';
// promote.js — the Roost "Promote to live" button's API (b347, 2026-09-21).
//
// Toby: "a promote dev to prod button" — one click, read the diff first, checks behind it.
//
// THIS FILE NEVER RUNS ANYTHING. wren-ladn has no way onto the host and must not get one. It writes
// small DATA-ONLY request files into a spool folder on /app/data (a bind mount the host can read)
// and reads back what the host worker wrote. The worker (ops/promote/worker.js, woken by systemd
// when a request appears — no timer, no cron) does the real work; see ops/promote/README.md.
// The task runner (:3847) could not be used: it listens on 127.0.0.1 only and has no such endpoint.
//
// Who may press it: the admin (Roost) portal only, a manager, AND on the Roost allowlist
// (ladn.settings 'roost_admin_staff_ids' — Toby only, by default). Unlike isRoostAllowed() this
// FAILS CLOSED: an unset allowlist means nobody but staff id 1, never "everybody".
//
// The button cannot be tricked into promoting something the person did not read: the request
// carries the plan's fingerprint (planHash), and the worker rebuilds the plan and refuses if
// anything moved. Files that need a named OK (hand-patched on prod, or a page that lost something)
// must be named in `confirm`.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const authenticate = require('../middleware/auth');
const { getRoostAllowlist } = require('../lib/roost-allowlist');

const router = express.Router();
const SPOOL = process.env.PROMOTE_SPOOL || '/app/data/promote';
const ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const MIGRATION_RE = /^(?:scripts\/)?migrations\/[A-Za-z0-9._-]+\.sql$/;
const MGR_ROLES = ['manager', 'deputy_manager', 'admin'];
const PLAN_MAX_AGE_MS = 30 * 60 * 1000;

const newId = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + crypto.randomBytes(4).toString('hex');
const p = (...a) => path.join(SPOOL, ...a);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const spoolReady = () => { try { return fs.statSync(p('requests')).isDirectory(); } catch { return false; } };

async function mayPromote(req) {
  const u = req.user;
  if (!u || req._portal !== 'admin') return false;
  const id = Number(u.id);
  if (!(MGR_ROLES.includes(u.role) || id === 1)) return false;
  if (process.env.WREN_EDITION && process.env.WREN_EDITION !== 'ladn') return false;   // never on a demo/school edition
  if (id === 1) return true;
  const { ids, configured } = await getRoostAllowlist();
  return configured === true && Array.isArray(ids) && ids.includes(id);
}

router.use(authenticate);
router.use(async (req, res, next) => {
  try {
    if (!(await mayPromote(req))) return res.status(403).json({ error: 'not_allowed', message: 'Promoting to live is limited to the Roost owner.' });
    if (!spoolReady()) return res.status(503).json({ error: 'not_set_up', message: 'The promote spool has not been created on the server yet. On docker-work run: node ops/promote/promote.js init' });
    next();
  } catch (e) {
    console.error('[promote] gate failed:', e.message);
    res.status(500).json({ error: 'gate_failed' });
  }
});

function pendingRequests() {
  try { return fs.readdirSync(p('requests')).filter((f) => f.endsWith('.json')); } catch { return []; }
}

// A run is "active" while its status says running AND it has been touched recently. A worker that died
// mid-run leaves a 'running' file behind; after STALE_MS it stops blocking the next promotion.
const STALE_MS = 30 * 60 * 1000;
function activeRun() {
  try {
    for (const f of fs.readdirSync(p('runs')).filter((x) => x.endsWith('.json'))) {
      const r = readJson(p('runs', f));
      if (!r || r.state !== 'running' || !['promote', 'migrate', 'undo'].includes(r.kind)) continue;
      let age = 0; try { age = Date.now() - fs.statSync(p('runs', f)).mtimeMs; } catch { /* raced */ }
      if (age < STALE_MS) return r;
    }
  } catch { /* none */ }
  return null;
}

function writeRequest(req, body) {
  const id = newId();
  const o = { v: 1, id, at: new Date().toISOString(), by: { id: Number(req.user.id), name: String(req.user.name || req.user.first_name || '').slice(0, 80) }, ...body };
  const tmp = p('requests', `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(o), { flag: 'wx' });
  fs.renameSync(tmp, p('requests', `${id}.json`));                 // atomic: the host never sees half a file
  return id;
}

function busy(res) {
  if (pendingRequests().length >= 3) { res.status(429).json({ error: 'too_many', message: 'There are already requests waiting for the server. Give it a moment.' }); return true; }
  return false;
}

const summarise = (r) => ({ id: r.id, kind: r.kind, state: r.state, phase: r.phase, startedAt: r.startedAt, finishedAt: r.finishedAt, by: r.by || null, counts: r.counts || null, target: r.target || null, summary: r.result && r.result.summary || null, resultKind: r.result && r.result.kind || null });

// GET /status — worker seen? anything running? recent runs.
router.get('/status', (req, res) => {
  const worker = readJson(p('worker.json'));
  let runs = [];
  try { runs = fs.readdirSync(p('runs')).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 15).map((f) => readJson(p('runs', f))).filter(Boolean).map(summarise); } catch { /* none */ }
  const pending = pendingRequests();
  let oldestMs = 0;
  for (const f of pending) { try { oldestMs = Math.max(oldestMs, Date.now() - fs.statSync(p('requests', f)).mtimeMs); } catch { /* raced */ } }
  const active = activeRun();
  res.json({ ok: true, worker: worker ? { lastRun: worker.at, profile: worker.profile } : null, pending: pending.length, oldestPendingMs: oldestMs, active: active ? summarise(active) : null, runs });
});

// POST /plans — ask the worker to compare dev with live (read-only on the server side).
router.post('/plans', (req, res) => {
  if (busy(res)) return;
  try { res.json({ ok: true, id: writeRequest(req, { type: 'plan' }) }); }
  catch (e) { console.error('[promote] plan request failed:', e.message); res.status(500).json({ error: 'write_failed', message: 'Could not leave a request for the server.' }); }
});

router.get('/plans/:id', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  const j = readJson(p('plans', `${req.params.id}.json`));
  if (!j) return res.json({ state: 'queued' });                    // request written, worker has not picked it up yet
  res.json(j);
});

router.get('/plans/:id/diff/:n', (req, res) => {
  const n = parseInt(req.params.n, 10);
  if (!ID_RE.test(req.params.id) || !Number.isInteger(n) || n < 1 || n > 5000) return res.status(400).json({ error: 'bad_id' });
  try {
    res.json({ text: fs.readFileSync(p('plans', req.params.id, `diff-${n}.txt`), 'utf8') });
  } catch { res.status(404).json({ error: 'no_diff' }); }
});

// POST /promote — { plan_id, plan_hash, confirm: [paths] }
router.post('/promote', (req, res) => {
  const b = req.body || {};
  if (!ID_RE.test(b.plan_id)) return res.status(400).json({ error: 'bad_plan', message: 'Which plan?' });
  const confirm = Array.isArray(b.confirm) ? b.confirm.filter((x) => typeof x === 'string').slice(0, 500) : [];
  const j = readJson(p('plans', `${b.plan_id}.json`));
  if (!j || j.state !== 'done' || !j.plan) return res.status(404).json({ error: 'no_plan', message: 'That plan is not ready or no longer exists. Check again.' });
  const plan = j.plan;
  if (typeof b.plan_hash !== 'string' || b.plan_hash !== plan.planHash) return res.status(409).json({ error: 'hash_mismatch', message: 'That is not the plan you were shown. Check again.' });
  if (Date.now() - Date.parse(plan.createdAt) > PLAN_MAX_AGE_MS) return res.status(409).json({ error: 'plan_too_old', message: 'That plan is over 30 minutes old — dev or live may have moved. Check again and read the new one.' });
  if (!plan.ready) return res.status(409).json({ error: 'not_ready', message: 'That plan has problems that must be fixed first.' });
  const missing = (plan.needsConfirm || []).filter((x) => !confirm.includes(x));
  if (missing.length) return res.status(400).json({ error: 'confirm_missing', message: `${missing.length} file(s) need your named OK first.`, missing });
  if (activeRun() || busy(res)) { if (!res.headersSent) res.status(409).json({ error: 'in_progress', message: 'A promotion or migration is already running.' }); return; }
  try {
    const id = writeRequest(req, { type: 'promote', planId: b.plan_id, planHash: plan.planHash, confirm: confirm.filter((x) => (plan.needsConfirm || []).includes(x)) });
    res.json({ ok: true, run_id: id });
  } catch (e) { console.error('[promote] promote request failed:', e.message); res.status(500).json({ error: 'write_failed', message: 'Could not leave a request for the server.' }); }
});

// POST /migrate — { plan_id, files: [migration paths listed as pending in that plan] }
router.post('/migrate', (req, res) => {
  const b = req.body || {};
  if (!ID_RE.test(b.plan_id)) return res.status(400).json({ error: 'bad_plan' });
  const files = Array.isArray(b.files) ? b.files.filter((x) => typeof x === 'string' && MIGRATION_RE.test(x)).slice(0, 60) : [];
  if (!files.length) return res.status(400).json({ error: 'no_files', message: 'Which migrations?' });
  const j = readJson(p('plans', `${b.plan_id}.json`));
  if (!j || j.state !== 'done' || !j.plan) return res.status(404).json({ error: 'no_plan' });
  const offered = new Map((j.plan.migrations || []).map((m) => [m.rel, m]));
  const bad = files.filter((f) => !offered.has(f) || !offered.get(f).canRun);
  if (bad.length) return res.status(400).json({ error: 'not_offered', message: `Not runnable from here: ${bad.slice(0, 3).join(', ')}` });
  if (activeRun() || busy(res)) { if (!res.headersSent) res.status(409).json({ error: 'in_progress', message: 'A promotion or migration is already running.' }); return; }
  try { res.json({ ok: true, run_id: writeRequest(req, { type: 'migrate', planId: b.plan_id, files }) }); }
  catch (e) { console.error('[promote] migrate request failed:', e.message); res.status(500).json({ error: 'write_failed' }); }
});

// POST /undo — { run_id } put back everything that promotion changed (latest only; the worker checks).
router.post('/undo', (req, res) => {
  const b = req.body || {};
  if (!ID_RE.test(b.run_id)) return res.status(400).json({ error: 'bad_run' });
  const r = readJson(p('runs', `${b.run_id}.json`));
  if (!r || r.kind !== 'promote' || r.state !== 'done') return res.status(404).json({ error: 'not_undoable', message: 'That is not a completed promotion.' });
  if (activeRun() || busy(res)) { if (!res.headersSent) res.status(409).json({ error: 'in_progress', message: 'A promotion or migration is already running.' }); return; }
  try { res.json({ ok: true, run_id: writeRequest(req, { type: 'undo', runId: b.run_id }) }); }
  catch (e) { console.error('[promote] undo request failed:', e.message); res.status(500).json({ error: 'write_failed' }); }
});

router.get('/runs/:id', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  const r = readJson(p('runs', `${req.params.id}.json`));
  if (!r) return res.json({ state: 'queued', id: req.params.id });
  res.json(r);
});

module.exports = router;
