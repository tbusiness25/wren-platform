'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// What version is this, really? (2026-09-24)
//
// Toby: "in the settings have a build number, and then they can check and give me the build
// number if I am remote and I can check they are on the latest version."
//
// The honest answer has two halves, and a cached tablet makes them disagree:
//   server  — what the container is running, stamped when the image was built
//   client  — what the browser actually loaded
// A stale tablet shows an old client against a current server, which is exactly the fault
// Toby wants to diagnose down the phone. So both are reported, and the page says when they
// differ rather than showing one number and implying agreement.
// ─────────────────────────────────────────────────────────────────────────────
const { execSync } = require('child_process');
const fs = require('fs');

let cached = null;

function buildInfo() {
  if (cached) return cached;
  let commit = process.env.WREN_BUILD_COMMIT || '';
  let builtAt = process.env.WREN_BUILD_AT || '';
  if (!commit) {
    try { commit = execSync('git rev-parse --short HEAD', { cwd: '/app', stdio: ['ignore','pipe','ignore'] }).toString().trim(); }
    catch (_) { commit = ''; }
  }
  if (!builtAt) {
    // the image build stamps this file; fall back to when the app's entrypoint was written
    for (const f of ['/app/BUILD_AT', '/app/package.json']) {
      try { builtAt = fs.statSync(f).mtime.toISOString(); break; } catch (_) { /* next */ }
    }
  }
  const short = (builtAt || '').slice(0, 16).replace('T', ' ');
  cached = {
    build: short ? short.replace(/[-: ]/g, '').slice(0, 12) : 'unknown',   // e.g. 202609241100
    commit: commit || 'unknown',
    built_at: builtAt || null,
    node: process.version,
  };
  return cached;
}

module.exports = { buildInfo };
