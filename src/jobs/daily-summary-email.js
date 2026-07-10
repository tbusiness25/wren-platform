// Daily summary email — sent at 07:00 Europe/London covering last 24h
// Scheduled via startCron() called from server-unified.js
'use strict';

const { getPool } = require('../db/pool');
const { sendEmail } = require('../lib/notifications');

async function sendDailySummary() {
  const db = getPool();
  const now = new Date();
  const coverageEnd   = new Date(now);
  const coverageStart = new Date(now - 24 * 60 * 60 * 1000);

  console.log('[daily-summary] building summary for', coverageStart.toISOString(), '→', coverageEnd.toISOString());

  // Gather counts from last 24h (use try/catch per query so one missing table doesn't break all)
  async function safeCount(sql, params) {
    try {
      const r = await db.query(sql, params || []);
      return parseInt(r.rows[0]?.count || '0', 10);
    } catch {
      return 0;
    }
  }

  const [incidents, safeguarding, messages, enquiries, absences, repairs] = await Promise.all([
    safeCount(`SELECT COUNT(*) FROM incidents WHERE created_at >= $1`, [coverageStart]),
    safeCount(`SELECT COUNT(*) FROM safeguarding_concerns WHERE created_at >= $1`, [coverageStart]),
    safeCount(`SELECT COUNT(*) FROM messages WHERE created_at >= $1 AND sender_type='parent'`, [coverageStart]),
    safeCount(`SELECT COUNT(*) FROM enquiries WHERE created_at >= $1`, [coverageStart]),
    safeCount(`SELECT COUNT(*) FROM absence_requests WHERE created_at >= $1`, [coverageStart]),
    safeCount(`SELECT COUNT(*) FROM repairs WHERE reported_at >= $1`, [coverageStart]),
  ]);

  // Count unread notifications for manager
  const unreadNotifs = await safeCount(
    `SELECT COUNT(*) FROM notifications WHERE recipient_type IN ('all-managers','all-staff') AND read_at IS NULL AND created_at >= $1`,
    [coverageStart]
  );

  const items = [
    { label: 'Incidents logged',           count: incidents,     urgent: incidents > 0 },
    { label: 'Safeguarding concerns',       count: safeguarding,  urgent: safeguarding > 0 },
    { label: 'Parent messages received',    count: messages,      urgent: false },
    { label: 'New enquiries',               count: enquiries,     urgent: false },
    { label: 'Absence requests',            count: absences,      urgent: false },
    { label: 'Repair reports',              count: repairs,       urgent: false },
    { label: 'Unread system notifications', count: unreadNotifs,  urgent: false },
  ];

  const totalItems = items.reduce((s, i) => s + i.count, 0);
  const urgentCount = items.filter(i => i.urgent).length;

  const dateLabel = now.toLocaleDateString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const coverageLabel = coverageStart.toLocaleString('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  }) + ' → ' + coverageEnd.toLocaleString('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });

  const statusColor = urgentCount > 0 ? '#ef4444' : '#22c55e';
  const statusText  = urgentCount > 0
    ? `${urgentCount} item${urgentCount !== 1 ? 's' : ''} need${urgentCount === 1 ? 's' : ''} attention`
    : 'All clear';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LADN Daily Summary</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

  <!-- Header -->
  <div style="background:#0f172a;padding:24px 28px">
    <div style="font-size:1rem;font-weight:700;color:#4a9abf;letter-spacing:0.05em;text-transform:uppercase">Your Nursery</div>
    <div style="font-size:1.4rem;font-weight:700;color:#f1f5f9;margin-top:4px">Daily Summary</div>
    <div style="font-size:0.82rem;color:#64748b;margin-top:4px">${dateLabel}</div>
  </div>

  <!-- Status bar -->
  <div style="background:${urgentCount > 0 ? '#fef2f2' : '#f0fdf4'};padding:12px 28px;border-bottom:2px solid ${statusColor}22">
    <span style="color:${statusColor};font-weight:600;font-size:0.9rem">${statusText}</span>
    <span style="color:#94a3b8;font-size:0.8rem;margin-left:8px">Coverage: ${coverageLabel}</span>
  </div>

  <!-- Items table -->
  <div style="padding:20px 28px">
    <table style="width:100%;border-collapse:collapse">
      ${items.map(item => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#374151;font-size:0.88rem">${item.label}</td>
        <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;font-size:0.95rem;color:${item.urgent && item.count > 0 ? '#ef4444' : item.count > 0 ? '#e07820' : '#22c55e'}">${item.count}</td>
      </tr>`).join('')}
    </table>

    <div style="margin-top:20px;padding:14px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
      <div style="font-size:0.82rem;color:#64748b">
        <strong style="color:#0f172a">Total activity:</strong> ${totalItems} event${totalItems !== 1 ? 's' : ''} in last 24 hours
      </div>
    </div>

    <div style="margin-top:16px">
      <a href="https://admin.example-nursery.co.uk" style="display:inline-block;background:#4a9abf;color:#fff;text-decoration:none;border-radius:8px;padding:10px 20px;font-size:0.85rem;font-weight:600">Open Admin Portal →</a>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#f8fafc;padding:16px 28px;border-top:1px solid #e2e8f0">
    <div style="font-size:0.75rem;color:#94a3b8">Your Nursery · 1A Example Lane, W13 9LU · Mon–Fri 8am–6pm</div>
    <div style="font-size:0.72rem;color:#cbd5e1;margin-top:4px">Automated daily summary from Wren. To adjust, visit Admin → System → Notifications.</div>
  </div>

</div>
</body>
</html>
  `.trim();

  await sendEmail(
    'toby@example-nursery.co.uk',
    `LADN Daily Summary — ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    html,
    'daily_summary'
  );

  // Log the send
  try {
    await db.query(
      `INSERT INTO daily_summary_log (coverage_start, coverage_end, items_count, email_to)
       VALUES ($1, $2, $3, $4)`,
      [coverageStart, coverageEnd, totalItems, 'toby@example-nursery.co.uk']
    );
  } catch (e) {
    console.error('[daily-summary] log insert failed:', e.message);
  }

  console.log('[daily-summary] completed, total items:', totalItems, 'urgent:', urgentCount);
  return { totalItems, urgentCount };
}

// Called from server — checks time each minute, fires at 07:00 Europe/London
function startCron() {
  let lastFiredDate = null;

  setInterval(() => {
    const now = new Date();
    const londonFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const parts = Object.fromEntries(londonFmt.map(p => [p.type, p.value]));
    const ukHour = parseInt(parts.hour, 10);
    const ukMin  = parseInt(parts.minute, 10);
    const today  = now.toDateString();

    if (ukHour === 7 && ukMin === 0 && lastFiredDate !== today) {
      lastFiredDate = today;
      sendDailySummary()
        .then(r => console.log(`[daily-summary] fired: ${r.totalItems} items`))
        .catch(e => console.error('[daily-summary] error:', e.message));
    }
  }, 60000); // check every minute

  console.log('[daily-summary] daily summary cron started (fires 07:00 Europe/London)');
}

module.exports = { sendDailySummary, startCron };
