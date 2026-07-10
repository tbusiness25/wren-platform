// Self-host stub for scripts/sync-cf-allowlist.js
//
// The production build syncs a Cloudflare Access allowlist from the parent
// email list. That feature is specific to the hosted LADN deployment (and the
// original file embedded private API tokens), so it is intentionally NOT part
// of this self-host bundle. The route code that referenced it has its calls
// commented out, but the module is still `require`d at import time — this no-op
// keeps that import working without shipping any secrets.

async function syncCFAllowlist() {
  // Intentionally does nothing in the self-host edition.
  return 0;
}

module.exports = { syncCFAllowlist };
