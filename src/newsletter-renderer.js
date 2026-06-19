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

function renderSection(section) {
  switch (section.section_type) {
    case 'text':          return renderTextSection(section);
    case 'planning_week': return renderPlanningWeekSection(section);
    case 'feature_grid':  return renderFeatureGridSection(section);
    case 'card':          return renderCardSection(section);
    case 'cta':           return renderCtaSection(section);
    case 'security_note': return renderSecurityNoteSection(section);
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

  const bodyHtml = sorted.map((s, i) => {
    const html    = renderSection(s);
    const divider = i < sorted.length - 1 ? renderDivider() : '';
    return html + divider;
  }).join('');

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
        <tr><td align="center" style="padding-bottom:20px">
          <img src="https://staff.example.com/little-angels-logo.png"
               alt="Your Nursery" width="80" height="80"
               style="border-radius:14px;background:#ffffff;padding:6px;display:block;margin:0 auto"
               onerror="this.style.display='none'">
        </td></tr>
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
            1A Example Lane, Ealing, London W13 9LU<br>
            <a href="tel:01234567890" style="color:#4a9abf;text-decoration:none">01234 567890</a>
            &nbsp;·&nbsp;
            <a href="mailto:admissions@example.com" style="color:#4a9abf;text-decoration:none">admissions@example.com</a><br>
            Mon–Fri 8:00am–6:00pm &nbsp;·&nbsp; Established 1990
          </p>
          <p style="margin:14px 0 0">
            <a href="https://www.example.com" style="color:#4a9abf;font-family:'DM Sans',Arial,sans-serif;font-size:12px;text-decoration:none">www.example.com</a>
          </p>
        </td></tr>
      </table>
    </div>

  </div>
</body>
</html>`;
}

module.exports = { renderNewsletter };
