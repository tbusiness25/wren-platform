'use strict';
const { getPool } = require('../db/pool');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;

// login-20261023: through the one Telegram sender (src/lib/notifications.js), which carries the dev guard.
async function sendTelegram(text) {
  const r = await require('../lib/notifications').sendTelegramNow({ text, parse_mode: null });
  if (!r.ok && !r.skipped) throw new Error(`Telegram ${r.status || r.error || 'send failed'}`);
}

async function runDailyDigest() {
  const db = getPool();

  const { rows: calls } = await db.query(`
    SELECT id, started_at, duration_seconds, from_number, outcome, urgency,
           summary, reviewed_at, safeguarding_flagged, audio_download_status
    FROM vapi_calls
    WHERE started_at::date = (now() AT TIME ZONE 'Europe/London')::date
      AND id NOT LIKE 'smoke-%'
    ORDER BY started_at DESC
  `);

  const total = calls.length;
  const dateStr = new Date().toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });

  if (!total) {
    await sendTelegram(`Aria Daily Digest - ${dateStr}\n\nNo calls today.`);
    return { total: 0 };
  }

  const byOutcome = {};
  let totDuration = 0;
  let unreviewed  = 0;
  let sgFlagged   = 0;
  const urgentCalls = [];

  for (const c of calls) {
    const out = c.outcome || 'unknown';
    byOutcome[out] = (byOutcome[out] || 0) + 1;
    totDuration += c.duration_seconds || 0;
    if (!c.reviewed_at) unreviewed++;
    if (c.safeguarding_flagged) sgFlagged++;
    if (c.urgency === 'urgent' || c.urgency === 'high') urgentCalls.push(c);
  }

  const avgDur = Math.round(totDuration / total);
  const outcomeLines = Object.entries(byOutcome)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  let msg = `Aria Daily Digest - ${dateStr}\n\n`;
  msg += `Calls: ${total}  |  Avg duration: ${avgDur}s\n`;
  msg += `Unreviewed: ${unreviewed}`;
  if (sgFlagged) msg += `  |  SAFEGUARDING FLAGS: ${sgFlagged}`;
  msg += `\n\nBy outcome:\n${outcomeLines}`;

  if (urgentCalls.length) {
    msg += `\n\nUrgent / High priority (${urgentCalls.length}):\n`;
    urgentCalls.slice(0, 4).forEach(c => {
      const from = c.from_number || 'unknown';
      const sum  = (c.summary || '').substring(0, 70);
      msg += `- ${from}: ${sum || '(no summary)'}\n`;
    });
  }

  if (unreviewed > 0) {
    msg += `\nReview: admin.example-nursery.co.uk/admin/communications`;
  }

  await sendTelegram(msg);
  console.log(`[vapi-digest] sent: ${total} calls, ${unreviewed} unreviewed, ${sgFlagged} SG`);
  return { total, unreviewed, sgFlagged };
}

// Called from server — schedule 18:30 UK time via polling loop
function startCron() {
  let lastFiredDate = null;

  setInterval(() => {
    const now = new Date();
    // UK time offset (handles BST/GMT)
    const ukHour = parseInt(now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }));
    const ukMin  = now.getMinutes();
    const today  = now.toDateString();

    if (ukHour === 18 && ukMin === 30 && lastFiredDate !== today) {
      lastFiredDate = today;
      runDailyDigest()
        .then(r => console.log(`[vapi-digest] fired: ${r.total} calls`))
        .catch(e => console.error('[vapi-digest] error:', e.message));
    }
  }, 60000); // check every minute

  console.log('[vapi-digest] daily cron started (fires 18:30 Europe/London)');
}

module.exports = { runDailyDigest, startCron };
