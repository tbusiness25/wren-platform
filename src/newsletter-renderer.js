'use strict';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function processMarkdown(text) {
  return esc(text || '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n\n+/g, '</p><p style="font-family:\'DM Sans\',Arial,sans-serif;font-size:15px;line-height:1.75;color:#4a4035;margin:0 0 14px 0">')
    .replace(/\n/g, '<br>');
}

function sectionContent(section) {
  return (section.final_content || section.ai_draft || section.raw_notes || '').trim();
}

// ── Section renderers ────────────────────────────────────────────────────────

function renderTextSection(section) {
  const content = sectionContent(section);
  const title = section.title || '';
  return `
<div style="margin:0 0 36px 0">
  ${title ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:700;color:#4a9abf;text-transform:uppercase;letter-spacing:.12em;margin:0 0 6px 0">${esc(title)}</p>
  <div style="width:36px;height:3px;background:#4a9abf;margin:0 0 16px 0;border-radius:2px"></div>` : ''}
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;line-height:1.75;color:#4a4035;margin:0 0 14px 0">${processMarkdown(content)}</p>
</div>`;
}

function renderPlanningWeekSection(section) {
  const meta = section.metadata || {};
  const days = meta.days || [];
  const title = section.title || 'Weekly Highlights';
  const room = meta.room || '';

  const dayColors = {
    monday: '#4a9abf', tuesday: '#e07820', wednesday: '#22c55e',
    thursday: '#7c3aed', friday: '#f59e0b'
  };
  const dayLabels = {
    monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
    thursday: 'Thursday', friday: 'Friday'
  };

  const dayRows = days.map(d => `
    <tr>
      <td valign="top" style="padding:10px 16px 10px 0;width:110px;vertical-align:top">
        <div style="display:flex;align-items:center;gap:7px">
          <div style="width:9px;height:9px;border-radius:50%;background:${dayColors[d.day] || '#4a9abf'};flex-shrink:0;margin-top:3px"></div>
          <span style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:700;color:#94877a;text-transform:uppercase;letter-spacing:.06em">${dayLabels[d.day] || esc(d.day || '')}</span>
        </div>
      </td>
      <td valign="top" style="padding:10px 0;border-bottom:1px solid #f0ebe3">
        <span style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#4a4035;line-height:1.5">${esc(d.activity || '')}</span>
      </td>
    </tr>`).join('');

  return `
<div style="margin:0 0 36px 0;border-radius:12px;overflow:hidden;border:1px solid #e8e0d6">
  <div style="background:#0f172a;padding:14px 20px">
    <table cellpadding="0" cellspacing="0" width="100%"><tr>
      <td>
        <span style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff">${esc(title)}</span>
      </td>
      ${room ? `<td align="right"><span style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:600;color:#4a9abf;background:rgba(74,154,191,.18);padding:3px 10px;border-radius:99px">${esc(room)}</span></td>` : ''}
    </tr></table>
  </div>
  <div style="background:#fffdf9;padding:4px 20px 4px">
    <table cellpadding="0" cellspacing="0" width="100%">${dayRows}</table>
  </div>
</div>`;
}

function renderFeatureGridSection(section) {
  const meta = section.metadata || {};
  const tiles = meta.tiles || [];
  const title = section.title || '';

  const tileColors = {
    blue: '#4a9abf', orange: '#e07820', navy: '#0f172a',
    green: '#22c55e', purple: '#7c3aed', amber: '#f59e0b'
  };

  // Build pairs for 2-column table layout
  const rows = [];
  for (let i = 0; i < tiles.length; i += 2) {
    const a = tiles[i], b = tiles[i + 1];
    rows.push(`
    <tr>
      <td width="50%" valign="top" style="padding:0 6px 12px 0">
        <div style="background:#fffdf9;border:1px solid #e8e0d6;border-top:4px solid ${tileColors[a.color] || '#4a9abf'};border-radius:10px;padding:16px">
          <div style="font-size:26px;margin:0 0 10px 0;line-height:1">${a.icon || '✨'}</div>
          <div style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:700;color:#0f172a;margin:0 0 6px 0">${esc(a.name || '')}</div>
          <div style="font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#6b6058;line-height:1.55">${esc(a.description || '')}</div>
        </div>
      </td>
      <td width="50%" valign="top" style="padding:0 0 12px 6px">
        ${b ? `<div style="background:#fffdf9;border:1px solid #e8e0d6;border-top:4px solid ${tileColors[b.color] || '#4a9abf'};border-radius:10px;padding:16px">
          <div style="font-size:26px;margin:0 0 10px 0;line-height:1">${b.icon || '✨'}</div>
          <div style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:700;color:#0f172a;margin:0 0 6px 0">${esc(b.name || '')}</div>
          <div style="font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#6b6058;line-height:1.55">${esc(b.description || '')}</div>
        </div>` : ''}
      </td>
    </tr>`);
  }

  return `
<div style="margin:0 0 36px 0">
  ${title ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:700;color:#4a9abf;text-transform:uppercase;letter-spacing:.12em;margin:0 0 6px 0">${esc(title)}</p>
  <div style="width:36px;height:3px;background:#4a9abf;margin:0 0 18px 0;border-radius:2px"></div>` : ''}
  <table cellpadding="0" cellspacing="0" width="100%">${rows.join('')}</table>
</div>`;
}

function renderCardSection(section) {
  const content = sectionContent(section);
  return `
<div style="margin:0 0 36px 0;background:#fffdf9;border:1px solid #e8e0d6;border-left:4px solid #e07820;border-radius:0 10px 10px 0;padding:20px 24px">
  ${section.title ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;font-weight:700;color:#0f172a;margin:0 0 10px 0">${esc(section.title)}</p>` : ''}
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#4a4035;line-height:1.7;margin:0">${processMarkdown(content)}</p>
</div>`;
}

function renderCtaSection(section) {
  const meta = section.metadata || {};
  const heading = meta.heading || section.title || "We'd love to hear from you";
  const body = meta.body || sectionContent(section) || '';
  const btnLabel = meta.button_label || 'Find Out More →';
  const btnUrl = meta.button_url || '#';

  return `
<div style="margin:0 0 36px 0;background:linear-gradient(135deg,#e07820 0%,#c96010 100%);border-radius:14px;padding:30px 32px;text-align:center">
  <div style="font-size:26px;margin:0 0 12px 0">💛</div>
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:20px;font-weight:700;color:#ffffff;margin:0 0 12px 0">${esc(heading)}</p>
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:rgba(255,255,255,.88);line-height:1.7;margin:0 0 22px 0">${processMarkdown(body)}</p>
  <a href="${esc(btnUrl)}" style="display:inline-block;background:#ffffff;color:#e07820;font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:700;text-decoration:none;padding:13px 30px;border-radius:8px">${esc(btnLabel)}</a>
</div>`;
}

function renderSecurityNoteSection(section) {
  const content = sectionContent(section);
  return `
<div style="margin:0 0 36px 0;background:#0f172a;border-radius:10px;padding:20px 24px">
  <table cellpadding="0" cellspacing="0" width="100%"><tr>
    <td valign="top" width="42" style="padding-right:14px;vertical-align:top">
      <div style="font-size:26px;line-height:1;margin-top:2px">🛡️</div>
    </td>
    <td valign="top">
      ${section.title ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:700;color:#4a9abf;text-transform:uppercase;letter-spacing:.1em;margin:0 0 6px 0">${esc(section.title)}</p>` : ''}
      <p style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#cbd5e1;line-height:1.65;margin:0">${processMarkdown(content)}</p>
    </td>
  </tr></table>
</div>`;
}

function renderDivider() {
  return `<div style="height:1px;background:linear-gradient(90deg,transparent,#e8e0d6 30%,#e8e0d6 70%,transparent);margin:0 0 36px 0"></div>`;
}


// ── b263 section renderers ───────────────────────────────────────────────────
// Tier 1 sections carry their content in metadata.items (assembled from Wren),
// not in final_content, so each needs its own renderer. Tier 3 sections are
// prose and mostly reuse the text/card shapes with their own emphasis.
//
// Inline styles throughout, matching the renderers above: this HTML is emailed,
// and email clients do not honour CSS variables or external stylesheets. The
// var(--c-*) rule applies to the app UI, which is a different surface.

const PARENTS_PORTAL = 'https://parents.example-nursery.co.uk';

function itemsOf(section) {
  const m = section.metadata || {};
  return Array.isArray(m.items) ? m.items : [];
}

function b263Heading(title, colour) {
  const c = colour || '#4a9abf';
  return title ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:700;color:${c};text-transform:uppercase;letter-spacing:.12em;margin:0 0 6px 0">${esc(title)}</p>
  <div style="width:36px;height:3px;background:${c};margin:0 0 16px 0;border-radius:2px"></div>` : '';
}

// The one ask. Deliberately the loudest thing in the newsletter after the
// intro — one concrete invitation, given room to be noticed. Five asks is zero
// asks, so there is only ever one of these.
function renderAskSection(section) {
  const content = sectionContent(section);
  const meta = section.metadata || {};
  return `
<div style="margin:0 0 36px 0;background:#fff8f0;border:2px solid #e07820;border-radius:14px;padding:26px 28px">
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:700;color:#e07820;text-transform:uppercase;letter-spacing:.12em;margin:0 0 10px 0">${esc(section.title || 'One thing we would love from you')}</p>
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:17px;line-height:1.65;color:#4a4035;margin:0">${processMarkdown(content)}</p>
  ${meta.by_when ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#8a7a68;margin:14px 0 0 0">By ${esc(meta.by_when)}</p>` : ''}
</div>`;
}

// You said, we did — closing the loop publicly.
function renderYouSaidWeDidSection(section) {
  const pairs = itemsOf(section);
  const body = pairs.length
    ? `<table cellpadding="0" cellspacing="0" width="100%">${pairs.map(p => `
      <tr><td style="padding:0 0 16px 0">
        <p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#8a7a68;margin:0 0 4px 0"><em>You said:</em> ${esc(p.said || '')}</p>
        <p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;color:#4a4035;margin:0;font-weight:600">We did: ${esc(p.did || '')}</p>
      </td></tr>`).join('')}</table>`
    : `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;line-height:1.75;color:#4a4035;margin:0">${processMarkdown(sectionContent(section))}</p>`;
  return `
<div style="margin:0 0 36px 0;background:#f4f9fb;border-radius:12px;padding:22px 26px">
  ${b263Heading(section.title || 'You said, we did')}
  ${body}
</div>`;
}

function renderTryAtHomeSection(section) {
  const meta = section.metadata || {};
  return `
<div style="margin:0 0 36px 0;background:#fffdf9;border:1px solid #e8e0d6;border-radius:12px;padding:22px 26px">
  ${b263Heading(section.title || 'One thing to try at home', '#22a06b')}
  ${meta.activity_name ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin:0 0 8px 0">${esc(meta.activity_name)}</p>` : ''}
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;line-height:1.75;color:#4a4035;margin:0">${processMarkdown(sectionContent(section))}</p>
  ${meta.linked_theme ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#8a7a68;margin:12px 0 0 0">Ties in with this half-term's theme: <strong>${esc(meta.linked_theme)}</strong></p>` : ''}
</div>`;
}

// Practitioner spotlight — with 40 families, parents can know all the staff.
function renderSpotlightSection(section) {
  const meta = section.metadata || {};
  return `
<div style="margin:0 0 36px 0;background:#fffdf9;border:1px solid #e8e0d6;border-left:4px solid #7c3aed;border-radius:0 12px 12px 0;padding:22px 26px">
  ${b263Heading(section.title || 'Meet the team', '#7c3aed')}
  ${meta.staff_name ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin:0 0 2px 0">${esc(meta.staff_name)}</p>` : ''}
  ${meta.staff_role ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#8a7a68;margin:0 0 12px 0">${esc(meta.staff_role)}</p>` : ''}
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;line-height:1.75;color:#4a4035;margin:0">${processMarkdown(sectionContent(section))}</p>
</div>`;
}

// What the team is learning — from the b262 deep-dive CPD theme.
function renderTeamLearningSection(section) {
  const meta = section.metadata || {};
  return `
<div style="margin:0 0 36px 0;background:#f4f9fb;border-radius:12px;padding:22px 26px">
  ${b263Heading(section.title || 'What our team is learning this half-term')}
  ${meta.theme_title ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin:0 0 8px 0">${esc(meta.theme_title)}</p>` : ''}
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;line-height:1.75;color:#4a4035;margin:0">${processMarkdown(sectionContent(section))}</p>
</div>`;
}

function renderDatesSection(section) {
  const items = itemsOf(section);
  if (!items.length) return '';
  return `
<div style="margin:0 0 36px 0">
  ${b263Heading(section.title || 'Dates for the half-term')}
  <table cellpadding="0" cellspacing="0" width="100%">${items.map(i => `
    <tr>
      <td style="padding:7px 12px 7px 0;font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#8a7a68;white-space:nowrap;vertical-align:top">${esc(i.label)}</td>
      <td style="padding:7px 0;font-family:'DM Sans',Arial,sans-serif;font-size:15px;color:#4a4035;font-weight:600">${esc(i.value)}</td>
    </tr>`).join('')}</table>
</div>`;
}

// What's on. Where an event needs an RSVP the button deep-links to the parents
// portal events page, which already carries the per-child RSVP controls — one
// RSVP path, not a second one bolted onto the newsletter.
function renderWhatsOnSection(section) {
  const items = itemsOf(section);
  if (!items.length) return '';
  return `
<div style="margin:0 0 36px 0">
  ${b263Heading(section.title || "What's on", '#e07820')}
  ${items.map(e => `
  <table cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 14px 0;background:#fffdf9;border:1px solid #e8e0d6;border-radius:10px">
    <tr><td style="padding:16px 20px">
      <p style="font-family:'DM Sans',Arial,sans-serif;font-size:16px;font-weight:700;color:#0f172a;margin:0 0 4px 0">${esc(e.title)}</p>
      <p style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#e07820;font-weight:600;margin:0 0 8px 0">${esc(e.date_pretty)}${e.time ? ' · ' + esc(e.time) : ''}${e.location ? ' · ' + esc(e.location) : ''}</p>
      ${e.description ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;line-height:1.7;color:#4a4035;margin:0">${processMarkdown(e.description)}</p>` : ''}
      ${e.rsvp_required ? `<p style="margin:14px 0 0 0"><a href="${PARENTS_PORTAL}/welcome/events" style="display:inline-block;background:#e07820;color:#ffffff;font-family:'DM Sans',Arial,sans-serif;font-size:13px;font-weight:700;text-decoration:none;padding:10px 20px;border-radius:7px">Let us know if you're coming →</a></p>` : ''}
    </td></tr>
  </table>`).join('')}
</div>`;
}

function renderTripsSection(section) {
  const items = itemsOf(section);
  if (!items.length) return '';
  return `
<div style="margin:0 0 36px 0">
  ${b263Heading(section.title || 'Trips and outings', '#22a06b')}
  ${items.map(o => `
  <div style="margin:0 0 12px 0;padding:0 0 0 16px;border-left:3px solid #22a06b">
    <p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;font-weight:700;color:#0f172a;margin:0 0 2px 0">${esc(o.destination)}</p>
    <p style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#22a06b;font-weight:600;margin:0 0 6px 0">${esc(o.date_pretty)}${o.transport ? ' · ' + esc(o.transport) : ''}</p>
    ${o.purpose ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;line-height:1.7;color:#4a4035;margin:0">${esc(o.purpose)}</p>` : ''}
    ${o.learning_intention ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#8a7a68;margin:6px 0 0 0"><em>${esc(o.learning_intention)}</em></p>` : ''}
  </div>`).join('')}
</div>`;
}

function renderThemeSection(section) {
  const items = itemsOf(section);
  if (!items.length) return '';
  return `
<div style="margin:0 0 36px 0">
  ${b263Heading(section.title || "What we're exploring this half-term")}
  ${items.map(t => `
  <div style="margin:0 0 16px 0">
    <p style="font-family:'Playfair Display',Georgia,serif;font-size:20px;font-weight:700;color:#0f172a;margin:0 0 6px 0">${esc(t.theme)}</p>
    ${t.key_books && t.key_books.length ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#4a4035;margin:0 0 4px 0"><strong>Books we'll share:</strong> ${t.key_books.map(esc).join(' · ')}</p>` : ''}
    ${t.songs && t.songs.length ? `<p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#4a4035;margin:0"><strong>Songs and rhymes:</strong> ${t.songs.map(esc).join(' · ')}</p>` : ''}
  </div>`).join('')}
</div>`;
}

// New starters. First names only — the assembler never puts a surname in the
// metadata, and every child here has a granted photo_media consent checked
// twice: once at assembly and again immediately before this renders.
function renderNewStartersSection(section) {
  const items = itemsOf(section);
  if (!items.length) return '';
  const names = items.map(c => esc(c.first_name) + (c.room ? ` <span style="color:#8a7a68">(${esc(c.room)})</span>` : ''));
  return `
<div style="margin:0 0 36px 0;background:#f4f9fb;border-radius:12px;padding:22px 26px">
  ${b263Heading(section.title || 'New faces joining us')}
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;line-height:1.9;color:#4a4035;margin:0">A very warm welcome to ${names.join(', ')}. We're so pleased to have you with us.</p>
</div>`;
}

function renderMenuSection(section) {
  const items = itemsOf(section);
  if (!items.length) return '';
  return `
<div style="margin:0 0 36px 0">
  ${b263Heading(section.title || 'On the menu', '#e07820')}
  <p style="font-family:'DM Sans',Arial,sans-serif;font-size:15px;line-height:1.8;color:#4a4035;margin:0">${items.map(m => esc(m.name)).join(' · ')}</p>
</div>`;
}

function renderFundingSection(section) {
  const items = itemsOf(section);
  if (!items.length) return '';
  return `
<div style="margin:0 0 36px 0;background:#fffdf9;border:1px solid #e8e0d6;border-radius:12px;padding:20px 24px">
  ${b263Heading(section.title || 'Funding — dates to know')}
  <table cellpadding="0" cellspacing="0" width="100%">${items.map(f => `
    <tr>
      <td style="padding:6px 12px 6px 0;font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#4a4035;vertical-align:top">${esc(f.name)}</td>
      <td style="padding:6px 0;font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#8a7a68;white-space:nowrap">from ${esc(f.term_starts_pretty)}</td>
    </tr>`).join('')}</table>
</div>`;
}

// The standing block. Renders LAST by sortWeight 900 — warm first, practical
// last. Kept to one screen deliberately; a newsletter that is mostly reminders
// stops being read.
function renderStandingBlockSection(section) {
  const items = itemsOf(section);
  if (!items.length) return '';
  return `
<div style="margin:0 0 12px 0;background:#f7f4ef;border-radius:12px;padding:24px 26px">
  ${b263Heading(section.title || 'The usual reminders', '#8a7a68')}
  <table cellpadding="0" cellspacing="0" width="100%">${items.map(i => `
    <tr><td style="padding:0 0 12px 0">
      <p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:700;color:#4a4035;margin:0 0 2px 0">${esc(i.heading)}</p>
      <p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;line-height:1.65;color:#6b5f52;margin:0">${esc(i.text)}</p>
    </td></tr>`).join('')}</table>
</div>`;
}

function renderSection(section) {
  switch (section.section_type) {
    case 'text':          return renderTextSection(section);
    case 'planning_week': return renderPlanningWeekSection(section);
    case 'feature_grid':  return renderFeatureGridSection(section);
    case 'card':          return renderCardSection(section);
    case 'cta':           return renderCtaSection(section);
    case 'security_note': return renderSecurityNoteSection(section);
    // ── b263 ────────────────────────────────────────────────────────────────
    // Tier 3 — written by a person
    case 'ask':             return renderAskSection(section);
    case 'you_said_we_did': return renderYouSaidWeDidSection(section);
    case 'try_at_home':     return renderTryAtHomeSection(section);
    case 'spotlight':       return renderSpotlightSection(section);
    case 'team_learning':   return renderTeamLearningSection(section);
    // Tier 1 — assembled from Wren
    case 'dates':           return renderDatesSection(section);
    case 'whats_on':        return renderWhatsOnSection(section);
    case 'trips':           return renderTripsSection(section);
    case 'theme':           return renderThemeSection(section);
    case 'new_starters':    return renderNewStartersSection(section);
    case 'menu':            return renderMenuSection(section);
    case 'funding':         return renderFundingSection(section);
    // Tier 2 — the standing block, always last
    case 'standing_block':  return renderStandingBlockSection(section);
    // 'intro' and 'what_weve_been' are prose and fall through to the text
    // renderer below, which is exactly right for them.
    default:              return renderTextSection(section);
  }
}

// ── Main renderer ────────────────────────────────────────────────────────────

function renderNewsletter(newsletter, sections) {
  const title     = newsletter.title || 'Your Nursery Newsletter';
  const term      = newsletter.term  || '';
  const fromName  = newsletter.from_name || 'Nursery Manager';
  const fromRole  = 'Manager';

  const sorted = [...(sections || [])].sort((a, b) => (a.section_order || 0) - (b.section_order || 0));

  // b263: a tier-1 section whose source found nothing renders as '' — render it
  // and THEN drop it, so an empty block cannot leave a stray divider floating in
  // the newsletter with nothing above it.
  const rendered = sorted
    .map(s => renderSection(s))
    .filter(h => h && h.trim());

  const bodyHtml = rendered
    .map((html, i) => html + (i < rendered.length - 1 ? renderDivider() : ''))
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@300;400;500;600;700&display=swap');
    body{margin:0;padding:0;background:#f0ebe3}
    a{color:#e07820}
    @media(max-width:620px){
      .nl-outer{padding:0!important}
      .nl-header,.nl-body,.nl-sig,.nl-footer{padding-left:24px!important;padding-right:24px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f0ebe3;font-family:'DM Sans',Arial,sans-serif">
  <div class="nl-outer" style="max-width:620px;margin:0 auto;padding:28px 0">

    <!-- ══ HEADER ══ -->
    <div class="nl-header" style="background:#0f172a;border-radius:16px 16px 0 0;padding:40px 44px 32px;text-align:center">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <!-- No logo image, and no images at all in a newsletter (Toby, 2026-09-04).
             The tag that used to sit here pointed at staff.example-nursery.co.uk,
             a host that does not resolve, so every parent got a broken-image icon —
             the onerror fallback never fired because mail clients do not run JS.
             The wordmark below is the header; it always renders. -->
        <tr><td align="center">
          <div style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:30px;font-weight:700;line-height:1.2;color:#ffffff">
            <span style="color:#4a9abf">Your Nursery</span><br>
            <span style="color:#e07820">Day Nursery</span>
          </div>
        </td></tr>
        <tr><td align="center" style="padding-top:16px">
          ${term ? `<div style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:600;color:#4a9abf;text-transform:uppercase;letter-spacing:.14em;margin-bottom:8px">${esc(term)}</div>` : ''}
          <div style="font-family:'Playfair Display',Georgia,serif;font-size:20px;color:#e2d9cc;font-weight:400;font-style:italic">${esc(title)}</div>
        </td></tr>
      </table>
    </div>

    <!-- ══ BODY ══ -->
    <div class="nl-body" style="background:#fffdf9;padding:36px 44px 8px">
      ${bodyHtml}
    </div>

    <!-- ══ SIGNATURE ══ -->
    <div class="nl-sig" style="background:#fffdf9;padding:0 44px 32px;border-top:1px solid #f0ebe3">
      <p style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#6b6058;line-height:1.9;margin:0">
        Warm regards,<br>
        <span style="font-family:'Playfair Display',Georgia,serif;font-size:20px;color:#0f172a;font-weight:700;line-height:1.3;display:block;margin-top:6px">${esc(fromName)}</span>
        <span style="color:#4a9abf;font-weight:500;font-size:13px">${esc(fromRole)}</span>
      </p>
    </div>

    <!-- ══ FOOTER ══ -->
    <div class="nl-footer" style="background:#0f172a;border-radius:0 0 16px 16px;padding:26px 44px;text-align:center">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding-bottom:14px">
          <div style="display:inline-flex;gap:16px;align-items:center">
            <span style="font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#4a9abf">Baby Room</span>
            <span style="color:#2d3748">·</span>
            <span style="font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#e07820">Pre-school</span>
          </div>
        </td></tr>
        <tr><td align="center">
          <p style="font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#64748b;line-height:2;margin:0">
            123 Example Lane, Your Town, AB1 2CD<br>
            <a href="tel:02079460000" style="color:#4a9abf;text-decoration:none">020 7946 0000</a>
            &nbsp;·&nbsp;
            <a href="mailto:info@example-nursery.co.uk" style="color:#4a9abf;text-decoration:none">info@example-nursery.co.uk</a><br>
            Mon–Fri 8:00am–6:00pm &nbsp;·&nbsp; Established 1990
          </p>
          <p style="margin:14px 0 0">
            <a href="https://www.example-nursery.co.uk" style="color:#4a9abf;font-family:'DM Sans',Arial,sans-serif;font-size:12px;text-decoration:none">www.example-nursery.co.uk</a>
          </p>
        </td></tr>
      </table>
    </div>

  </div>
</body>
</html>`;
}

module.exports = { renderNewsletter };
