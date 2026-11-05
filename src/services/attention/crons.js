'use strict';
/**
 * crons.js — b232 collector. Scheduled jobs that have gone quiet.
 *
 * A cron that stops does not tell anybody. It just stops, and the first sign is
 * a number that looks wrong three weeks later. This reads the real crontab, works
 * out how often each job is meant to run, and compares that against when its log
 * file was last written to.
 *
 *   log older than 2× the schedule interval   AMBER  (or RED if it moves money
 *                                                     or touches child safety)
 *   tail matches ERROR|FAIL|SKIPPED|Traceback AMBER  (same escalation)
 *
 * ── WHAT IT CANNOT SEE ──────────────────────────────────────────────────────
 * Only jobs that redirect to a log file it can stat. Jobs writing to /var/log
 * (root-owned), jobs with a `$(date)` in the filename, and jobs with no redirect
 * at all are skipped and counted in the note. Silence about a job here means
 * "not checked", not "healthy" — which is why the count of skipped jobs is
 * reported rather than swallowed.
 *
 * ── WHY IT RUNS ON THE HOST, AND HOW IT KNOWS ───────────────────────────────
 * `crontab -l` and /app/build-logs are host things; neither is mounted into
 * wren-ladn-dev. The first version assumed a failed `crontab -l` would be the
 * tell. It is not: the container image ships Alpine's own root crontab, so
 * `crontab -l` succeeds inside wren-ladn-dev and returns six `run-parts` lines
 * with no log redirects. The collector read that, found nothing wrong with any of
 * it, reported ok:true with zero items — and the refresh dutifully closed all
 * sixteen real cron findings as fixed.
 *
 * So "did the command work" is not the question. LOG_ROOT is: if the directory
 * the host's cron jobs write into is not there, this is not the host, and the
 * collector says so. A zero-job read is treated the same way — seeing nothing is
 * never the same as there being nothing.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const { classify } = require('./rag');

const SOURCE = 'crons';
// The marker that says "this is the host". Every scheduled job worth watching
// redirects into here; inside a container it does not exist.
const LOG_ROOT = process.env.ATTENTION_LOG_ROOT || '/app/build-logs';
const ERROR_RE = /\b(ERROR|FAILED|FAILURE|FAIL|SKIPPED|Traceback|Exception|ECONNREFUSED|fatal)\b/i;
const TAIL_BYTES = 4000;

// ── the noise filter ────────────────────────────────────────────────────────
// The first version of this collector flagged xero-sync, brighthr-sync and
// dd-billing-cycle as failing. All three were fine. They had written
//
//     reports ok=True periods=4 lines=93 aged=6 skipped=0
//     employees: 66 distinct, 19 current, 17 matched, 1 unmatched, 1 skipped(id=1)
//     [dd-billing] Done: { processed: 0, skipped: 0, failed: 0 }
//
// A healthy job reporting that nothing failed contains the word "failed". A board
// that cries wolf on three of its loudest cards is worse than no board at all, so
// every count-shaped use of the words is stripped out before the match runs.
const COUNT_NOISE = [
  /\b(failed|failures?|skipped|errors?|unmatched)\s*[:=]\s*\d+/gi,   // failed=0, skipped: 0
  /\b\d+\s+(failed|failures?|skipped|errors?|unmatched)\b/gi,        // 0 failed, 1 skipped
  /\bskipped\([^)]*\)/gi,                                          // skipped(id=1)
  /\b(ok|success)\s*[:=]\s*(true|True|\d+)/g,                       // ok=True
  /"(failed|skipped|errors?)"\s*:\s*\d+/gi,                         // JSON counters
];
function realErrorLines(tail) {
  return tail.split('\n').filter(line => {
    let l = line;
    for (const re of COUNT_NOISE) l = l.replace(re, ' ');
    return ERROR_RE.test(l);
  });
}

// Jobs whose failure costs money or touches a child. Matched against the command.
const MONEY_RE  = /xero|invoic|payment|billing|dd-billing|gocardless|stripe|payroll|reconcil|funding/i;
const SAFETY_RE = /safeguard|sg-chain|medicine|ratio|headcount|allergy|register|attendance|monitor|watchdog/i;

// ── cron schedule → longest gap we should ever see, in minutes ──────────────
function maxGapMinutes(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length < 5) return null;
  const [min, hour, dom, mon, dow] = f;

  const step = s => { const m = /^\*\/(\d+)$/.exec(s); return m ? parseInt(m[1], 10) : null; };
  const listLen = s => {
    if (s === '*') return null;
    let n = 0;
    for (const part of s.split(',')) {
      const r = /^(\d+)-(\d+)$/.exec(part);
      if (r) n += (parseInt(r[2], 10) - parseInt(r[1], 10) + 1);
      else if (/^\d+$/.test(part)) n += 1;
      else return null;
    }
    return n;
  };

  // sub-hourly
  const minStep = step(min);
  if (minStep && hour === '*') return minStep;
  if (min === '*' && hour === '*') return 1;

  // every-N-hours
  const hourStep = step(hour);
  if (hourStep) return hourStep * 60;

  // several fixed hours a day
  const hours = listLen(hour);
  if (hours && hours > 1 && dom === '*' && mon === '*' && dow === '*') return Math.ceil(1440 / hours);

  // monthly / quarterly
  if (step(mon)) return parseInt(/^\*\/(\d+)$/.exec(mon)[1], 10) * 31 * 1440;
  if (dom !== '*') return 31 * 1440;

  // weekly, or weekdays-only daily (Fri → Mon is a 3-day gap)
  if (dow !== '*') {
    const days = listLen(dow);
    if (days === 1) return 7 * 1440;
    return 3 * 1440;
  }
  return 1440;   // plain daily
}

// ── crontab parsing ─────────────────────────────────────────────────────────
function readCrontab() {
  return execFileSync('crontab', ['-l'], { encoding: 'utf8', timeout: 10000 });
}

function parseLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('#') || t.startsWith('@')) return null;
  const f = t.split(/\s+/);
  if (f.length < 6) return null;
  const expr = f.slice(0, 5).join(' ');
  if (!/^[\d*,\/\- ]+$/.test(expr)) return null;
  const cmd = f.slice(5).join(' ');
  // The last `>>` or `>` target that is a plain path.
  const redirects = [...cmd.matchAll(/>>?\s*("?)(\/[^\s"'|;&]+)\1/g)].map(m => m[2]);
  const log = redirects.filter(p => !p.includes('$(') && !p.includes('`')).pop() || null;
  return { expr, cmd, log };
}

/** A readable name for the job — the script, not the whole shell line. */
function jobName(cmd) {
  const m = cmd.match(/([\w.-]+\.(?:sh|js|py))\b/);
  if (m) return m[1];
  const d = cmd.match(/docker\s+exec\s+(\S+)/);
  if (d) return `docker exec ${d[1]}`;
  return cmd.split(/\s+/).slice(0, 3).join(' ');
}

function tailOf(path) {
  try {
    const st = fs.statSync(path);
    const fd = fs.openSync(path, 'r');
    const len = Math.min(TAIL_BYTES, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

async function collect() {
  // Guard 1 — are we even on the host?
  try {
    if (!fs.statSync(LOG_ROOT).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, items: [], note: `${LOG_ROOT} is not here — this is not the host, so nothing was checked` };
  }

  let raw;
  try { raw = readCrontab(); }
  catch (e) { return { ok: false, items: [], note: `crontab unreadable: ${e.message}` }; }

  const items = [];
  let checked = 0, skipped = 0;

  for (const line of raw.split('\n')) {
    const job = parseLine(line);
    if (!job) continue;
    if (!job.log) { skipped++; continue; }

    let st;
    try { st = fs.statSync(job.log); }
    catch { skipped++; continue; }          // root-owned or never created

    const gap = maxGapMinutes(job.expr);
    if (!gap) { skipped++; continue; }
    checked++;

    const ageMin = (Date.now() - st.mtimeMs) / 60000;
    const stale = ageMin > gap * 2;
    const tail = tailOf(job.log);
    const errLines = realErrorLines(tail);
    const errored = errLines.length > 0;
    if (!stale && !errored) continue;

    const name = jobName(job.cmd);
    const money  = MONEY_RE.test(job.cmd);
    const safety = SAFETY_RE.test(job.cmd);
    const c = classify({ money, childSafety: safety, cronStopped: true });

    const errLine = errored ? (errLines[errLines.length - 1] || '').trim().slice(0, 180) : null;

    items.push({
      source: SOURCE,
      source_key: job.log.replace(/^.*\//, '') + '::' + name,
      title: stale
        ? `Cron "${name}" has not written a log for ${humanMin(ageMin)}`
        : `Cron "${name}" is logging errors`,
      detail: [
        `Schedule \`${job.expr}\` — expected at least every ${humanMin(gap)}.`,
        `Last wrote to ${job.log} ${humanMin(ageMin)} ago.`,
        errLine ? `Last error line: ${errLine}` : null,
        money ? 'This job moves money.' : (safety ? 'This job touches child safety.' : null),
      ].filter(Boolean).join(' '),
      why: c.why,
      rag: c.rag,
      category: 'ops',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 10,
      action_url: '/admin/system/tech',
      evidence: {
        schedule: job.expr, log: job.log, expected_every_minutes: gap,
        last_write_minutes_ago: Math.round(ageMin), stale, errored,
        error_lines: errLines.slice(-3).map(l => l.trim().slice(0, 200)),
      },
      sort_hint: 3,
    });
  }

  // Guard 2 — a read that examined no job proves nothing. Reporting ok:true here
  // would let the refresh close every existing cron item as resolved.
  if (checked === 0) {
    return { ok: false, items: [], note: `crontab held ${skipped} entries but none had a readable log — nothing could be checked` };
  }

  return {
    ok: true,
    items,
    note: `${checked} cron jobs checked, ${skipped} skipped (no readable log or an unparsed schedule)`,
  };
}

function humanMin(m) {
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 60 * 36) return `${Math.round(m / 60)} hours`;
  return `${Math.round(m / 1440)} days`;
}

module.exports = { name: SOURCE, owns: [SOURCE], collect, _maxGapMinutes: maxGapMinutes, _parseLine: parseLine };
