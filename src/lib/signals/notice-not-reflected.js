'use strict';
/**
 * b311 signal — staff have left and the public availability page still shows
 * the world before they did.
 *
 * Toby: "you've had two people give notice and you haven't updated the website
 * yet". Fewer staff means fewer ratio places, and the availability page is the
 * one thing a prospective parent reads before ringing.
 *
 * THE QUESTION
 *   Are there staff whose leaving date falls between the last time
 *   availability.html was edited and `notice_horizon` from today — and has the
 *   page not been touched since?
 *
 * The window matters. "Leaving date after the page was last edited" on its own
 * is trivially true for anybody leaving next June, and a signal that is
 * trivially true is noise. So the window closes at leaver_notice_weeks from
 * today (settings, 6 weeks): people who have gone, or are about to.
 *
 * ── READ ONLY, AND EXPLICITLY SO ────────────────────────────────────────────
 * The dev container bind-mounts the LIVE public website read-WRITE at
 * /app/website-live. This file calls fs.promises.stat and nothing else — there
 * is no fs.writeFile, no fs.open, no path joined onto anything a caller
 * supplies. The directory is configurable (SIGNALS_PUBLIC_SITE_DIR env, then
 * settings.signals_public_site_dir) and when neither is set it will use
 * /app/website-live ONLY if that path already exists; otherwise the signal is
 * dormant and says so on the Roost screen rather than guessing at a path.
 */

const fs = require('fs').promises;
const path = require('path');
const U = require('./_util');

const FALLBACK_DIR = '/app/website-live';

async function resolvePage(ctx, filename) {
  const env = String(process.env.SIGNALS_PUBLIC_SITE_DIR || '').trim();
  const fromSetting = String(await ctx.setting('signals_public_site_dir', '') || '').trim();
  let dir = env || fromSetting;
  if (!dir) {
    try { await fs.stat(FALLBACK_DIR); dir = FALLBACK_DIR; } catch (_) { dir = ''; }
  }
  if (!dir) return { dir: '', file: '', reason: 'no public site directory configured (SIGNALS_PUBLIC_SITE_DIR / settings.signals_public_site_dir)' };
  const file = path.join(dir, filename);
  try {
    const st = await fs.stat(file);
    return { dir, file, mtime: st.mtime };
  } catch (e) {
    return { dir, file, reason: `${filename} not found under ${dir}` };
  }
}

module.exports = {
  key: 'notice_not_reflected',
  label: 'Staff have left, availability page not updated',
  question: 'Is there a leaver whose leaving date post-dates the last edit of the public availability page?',
  category: 'signal_website_stale',
  priority: 25,
  recipients: 'all-managers',
  link: '/website-builder.html',
  defaults: {
    min_leavers: 1,
    page: 'availability.html',
    cooldown_hours: 24 * 30,   // a month — this is a "get round to it", not an alarm
    min_gap_hours: 24 * 7,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;
    const page = await resolvePage(ctx, cfg.page || 'availability.html');
    if (!page.mtime) return { dormant: true, reason: page.reason };

    const editedOn = U.ymd(page.mtime);
    const noticeWeeks = parseInt(await ctx.setting('leaver_notice_weeks', '6'), 10) || 6;
    const horizon = U.addDays(today, noticeWeeks * 7);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n, min(termination_date) AS earliest, max(termination_date) AS latest
         FROM staff
        WHERE termination_date IS NOT NULL
          AND termination_date >  $1::date
          AND termination_date <= $2::date
          AND id <> 1`,
      [editedOn, horizon]);
    const n = rows[0].n;
    if (n < cfg.min_leavers) return null;

    const earliest = U.ymd(rows[0].earliest);
    const latest = U.ymd(rows[0].latest);

    return {
      fingerprint: U.fingerprint({ n, editedOn, earliest, latest }),
      headline: `${n} ${U.plural(n, 'member', 'members')} of staff ${U.plural(n, 'has', 'have')} a leaving date after `
        + `${U.longDate(editedOn)}, which is when ${cfg.page} on the public site was last edited. `
        + `The page still shows the availability you had before ${U.plural(n, 'that change', 'those changes')}.`,
      facts: { leavers_in_window: n, page: cfg.page, page_last_edited: editedOn,
               earliest_leaving_date: earliest, latest_leaving_date: latest,
               notice_horizon: horizon },
    };
  },
};
