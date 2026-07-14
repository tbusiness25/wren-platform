// Notifications wrapper — checks schedule prefs, working hours, away mode before sending
// Uses existing getPool() pattern (search_path=ladn set by pool)
'use strict';

const { getPool } = require('../db/pool');

const WORKING_HOURS = { start: 8, end: 18 }; // 08:00-18:00 Europe/London, Mon-Fri

// ── Working hours check ──────────────────────────────────────────────────────

function isWorkingHours() {
  const now = new Date();
  const londonTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);
  const parts = Object.fromEntries(londonTime.map(p => [p.type, p.value]));
  const day  = parts.weekday; // 'Mon', 'Tue', etc.
  const hour = parseInt(parts.hour, 10);
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  if (!weekdays.includes(day)) return false;
  return hour >= WORKING_HOURS.start && hour < WORKING_HOURS.end;
}

// Return next weekday 08:00 London time as a Date (UTC)
function nextWorkingDayStart() {
  const now = new Date();
  // Get London date components
  const londonStr = now.toLocaleString('en-GB', { timeZone: 'Europe/London' });
  // Build a London-midnight date by constructing from parts
  const londonFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(londonFmt.map(x => [x.type, x.value]));
  const londonHour = parseInt(p.hour, 10);

  // Start from today's 08:00 London, then advance if needed
  // Build a UTC Date that represents 08:00 London today
  // Easiest: use toLocaleString trick to find UTC offset
  const testDate = new Date(`${p.year}-${p.month}-${p.day}T08:00:00`);
  // This is 08:00 local (no timezone). Adjust:
  // We need the UTC equivalent of 08:00 London on the next working day.

  // Simpler: advance 'now' day by day until we land on a weekday
  const candidate = new Date(now);
  // Move past 18:00 today threshold (already past working hours)
  candidate.setDate(candidate.getDate() + 1);

  // Keep advancing until we hit Mon-Fri
  for (let i = 0; i < 7; i++) {
    const dayName = candidate.toLocaleDateString('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'short',
    });
    if (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(dayName)) break;
    candidate.setDate(candidate.getDate() + 1);
  }

  // Set to 08:00 London on candidate day
  // Get London midnight for that day
  const ymd = candidate.toLocaleDateString('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).split('/').reverse().join('-'); // dd/mm/yyyy -> yyyy-mm-dd

  // Create 08:00 London as UTC by formatting with timezone
  const target08London = new Date(
    new Date(`${ymd}T08:00:00`).toLocaleString('en-US', { timeZone: 'UTC' })
  );
  // Actually: construct a UTC date representing 08:00 London
  // We'll use the Intl offset approach:
  const londonOffset = getLondonUTCOffset(new Date(`${ymd}T08:00:00Z`));
  return new Date(`${ymd}T${String(8 - londonOffset).padStart(2, '0')}:00:00Z`);
}

function getLondonUTCOffset(date) {
  // Returns UTC offset in hours for Europe/London at given date
  // London is UTC+0 (GMT) or UTC+1 (BST)
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC', hour: 'numeric', hour12: false });
  const londonStr = date.toLocaleString('en-US', { timeZone: 'Europe/London', hour: 'numeric', hour12: false });
  return parseInt(londonStr, 10) - parseInt(utcStr, 10);
}

// ── Away mode check ──────────────────────────────────────────────────────────

async function isAwayModeActive() {
  try {
    const db = getPool();
    const r = await db.query('SELECT active FROM away_mode WHERE id=1 LIMIT 1');
    return r.rows.length > 0 && r.rows[0].active === true;
  } catch {
    return false;
  }
}

// ── Prefs lookup ─────────────────────────────────────────────────────────────

async function getSchedulePrefs(eventType, channel) {
  try {
    const db = getPool();
    const r = await db.query(
      `SELECT enabled, respect_working_hours, respect_away_mode
       FROM notification_schedule_prefs
       WHERE channel=$1 AND event_type=$2
       LIMIT 1`,
      [channel, eventType]
    );
    if (r.rows.length === 0) {
      // Default: enabled, respect working hours, respect away mode for telegram
      return {
        enabled: true,
        respect_working_hours: channel === 'telegram',
        respect_away_mode: channel === 'telegram',
      };
    }
    return r.rows[0];
  } catch {
    return { enabled: true, respect_working_hours: false, respect_away_mode: false };
  }
}

// ── Queue ─────────────────────────────────────────────────────────────────────

async function queueForLater(channel, eventType, payload) {
  try {
    const scheduledFor = nextWorkingDayStart();
    const db = getPool();
    await db.query(
      `INSERT INTO notification_queue (channel, event_type, payload, scheduled_for)
       VALUES ($1, $2, $3, $4)`,
      [channel, eventType, JSON.stringify(payload), scheduledFor.toISOString()]
    );
    console.log(`[notifications] queued ${channel}/${eventType} for ${scheduledFor.toISOString()}`);
  } catch (e) {
    console.error('[notifications] queue error:', e.message);
  }
}

// ── Telegram send (raw, no gate) ─────────────────────────────────────────────

async function sendTelegramNow(payload) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const text = typeof payload === 'string' ? payload : (payload.text || JSON.stringify(payload));
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[notifications] Telegram send failed:', res.status, body);
    }
  } catch (e) {
    console.error('[notifications] Telegram send error:', e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a Telegram notification respecting schedule prefs, working hours, away mode.
 * @param {string} eventType - e.g. 'wren_notification', 'incident', 'safeguarding'
 * @param {string|object} payload - text string or { text: '...' }
 */
async function sendTelegram(eventType, payload) {
  try {
    const prefs = await getSchedulePrefs(eventType, 'telegram');
    if (!prefs.enabled) return;

    // Away mode check
    if (prefs.respect_away_mode) {
      const away = await isAwayModeActive();
      if (away) {
        console.log(`[notifications] suppressed (away mode): telegram/${eventType}`);
        return;
      }
    }

    // Working hours check
    if (prefs.respect_working_hours && !isWorkingHours()) {
      await queueForLater('telegram', eventType, payload);
      return;
    }

    await sendTelegramNow(payload);
  } catch (e) {
    console.error('[notifications] sendTelegram error:', e.message);
  }
}

/**
 * Send email via nodemailer (SMTP from env) or log if not configured.
 * @param {string} to
 * @param {string} subject
 * @param {string} html
 * @param {string} [eventType]
 */
// Log every outbound email Wren sends into email_audit (previously logged nowhere).
async function _auditEmail(to, subject, eventType, source, ok, error) {
  try {
    const { getPool } = require('../db/pool');
    await getPool().query(
      `INSERT INTO email_audit (direction, to_emails, subject, event_type, source, sent_ok, error)
       VALUES ('out', $1, $2, $3, $4, $5, $6)`,
      [Array.isArray(to) ? to : [to], (subject || '').slice(0, 500), eventType || null, source, !!ok, error || null]);
  } catch (_) { /* never block sending on an audit failure */ }
}

async function sendEmail(to, subject, html, eventType = 'email') {
  try {
    const prefs = await getSchedulePrefs(eventType, 'email');
    if (!prefs.enabled) return false;

    // PREFERRED PATH: Gmail API via the Google service account (domain-wide
    // delegation, impersonating the Workspace mailbox). No external provider,
    // no n8n dependency. Falls through to SMTP / n8n only if Gmail is not
    // configured or the send genuinely fails.
    try {
      const gmail = require('./gmail-sender');
      if (gmail.isConfigured()) {
        const r = await gmail.sendViaGmail({ to, subject, html });
        if (r && r.ok) {
          console.log(`[notifications] email sent via Gmail API to ${to}: ${subject} (id ${r.messageId})`);
          _auditEmail(to, subject, eventType, 'gmail_api', true);
          return true;
        }
      }
    } catch (gerr) {
      // 403/unauthorized_client = DWD scope not propagated yet — log clearly,
      // then fall through to the legacy transports below.
      console.error('[notifications] Gmail API send failed, falling back:', gerr.message);
      _auditEmail(to, subject, eventType, 'gmail_api_error', false, gerr.message);
    }

    // Use nodemailer if SMTP fully configured (host + credentials)
    const smtpOk = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    if (smtpOk) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'wren@littleangelsealing.co.uk',
        to,
        subject,
        html,
      });
      console.log(`[notifications] email sent to ${to}: ${subject}`);
      _auditEmail(to, subject, eventType, 'smtp', true);
      return true;
    }

    // Fallback: try n8n webhook if configured
    const n8nWebhook = process.env.N8N_EMAIL_WEBHOOK;
    if (n8nWebhook) {
      const res = await fetch(n8nWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, html, eventType }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        console.log(`[notifications] email relayed via n8n to ${to}: ${subject}`);
        _auditEmail(to, subject, eventType, 'n8n_relay', true);
        return true;
      }
      throw new Error(`n8n relay HTTP ${res.status}`);
    }

    // Log only — no transport configured
    console.log(`[notifications] email not sent (no SMTP/n8n configured): ${to} — ${subject}`);
    _auditEmail(to, subject, eventType, 'log_only', false);
    return false;
  } catch (e) {
    console.error('[notifications] sendEmail error:', e.message);
    _auditEmail(to, subject, eventType, 'error', false, e.message);
    return false;
  }
}

module.exports = {
  sendTelegram,
  sendTelegramNow,
  sendEmail,
  isWorkingHours,
  isAwayModeActive,
  getSchedulePrefs,
};
