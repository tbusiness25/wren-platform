// login-20261023 — the Cloudflare Access lists (parents, staff HR, Roost), kept equal to Wren
// every morning at 07:17 Europe/London, from INSIDE the production container.
//
// Replaces the host crontab line that ran scripts/sync-cf-allowlist.js out of the dev checkout
// (/app) with the host's node and a copy of the parents query that had to be "kept in
// step" with src/lib/cf-allowlist.js by hand. Now there is one query (the lib), one schedule (this),
// and it runs on production's own code and env. Same 07:17 slot, so families see no change.
//
// Off LADN production every push refuses (assertLadnProd in the lib), so starting this on dev or
// on a demo is harmless — it logs one line a day and does nothing.
const { syncAllAccessLists } = require('../lib/cf-allowlist');

function startAccessListSync() {
  let lastFired = null;
  setInterval(() => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date()).map(p => [p.type, p.value]));
    const today = new Date().toDateString();
    if (parseInt(parts.hour, 10) === 7 && parseInt(parts.minute, 10) === 17 && lastFired !== today) {
      lastFired = today;
      syncAllAccessLists()
        .then(r => console.log('[access-list-sync]', JSON.stringify(r)))
        .catch(e => console.error('[access-list-sync]', e.message));
    }
  }, 60000).unref();
  console.log('[access-list-sync] started (07:17 Europe/London; LADN production only)');
}

module.exports = { startAccessListSync };
