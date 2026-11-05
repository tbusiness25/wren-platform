'use strict';
// wren-update-render.js — turns a "What's new in Wren" update into HTML.
//
// The body is plain text with three conventions, so a manager can write one
// without knowing HTML and nothing they type can inject markup:
//
//   ## Heading {live}      a section; {live} or {soon} adds a status pill
//   - a line               a bullet (a block where every line starts "- ")
//   **words**              bold
//
// Everything else is a paragraph; a blank line starts a new one. The page and
// the email both use this, so the two can never show different versions.

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = {
  live: { label: 'Live',        cls: 'live' },
  soon: { label: 'Coming soon', cls: 'soon' },
};

const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

// `pill(status)` lets the email use inline styles where the page uses classes.
function renderUpdate(body, { pill } = {}) {
  const makePill = pill || (st => `<span class="wu-pill ${st.cls}">${st.label}</span>`);
  const blocks = String(body || '').replace(/\r\n/g, '\n').split(/\n\s*\n/);
  return blocks.map(block => {
    const lines = block.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
    if (!lines.length) return '';
    const out = [];
    let i = 0;
    if (/^##\s+/.test(lines[0])) {
      let head = lines[0].replace(/^##\s+/, '');
      let st = null;
      const m = head.match(/\s*\{(live|soon)\}\s*$/i);
      if (m) { st = STATUS[m[1].toLowerCase()]; head = head.slice(0, m.index); }
      out.push(`<h3>${inline(head)}${st ? ' ' + makePill(st) : ''}</h3>`);
      i = 1;
    }
    const rest = lines.slice(i);
    if (!rest.length) return out.join('');
    if (rest.every(l => /^\s*-\s+/.test(l))) {
      out.push('<ul>' + rest.map(l => `<li>${inline(l.replace(/^\s*-\s+/, ''))}</li>`).join('') + '</ul>');
    } else {
      out.push(`<p>${rest.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }).join('\n');
}

// The email copy: same words, inline styles, no page CSS to lean on.
function renderUpdateEmail(update, { greeting, signoff } = {}) {
  const pill = st => {
    const c = st.cls === 'live' ? '#1f7a4d' : '#9a5b00';
    return `<span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;` +
      `text-transform:uppercase;color:${c};border:1px solid ${c};border-radius:999px;` +
      `padding:1px 8px;margin-left:6px;vertical-align:2px">${st.label}</span>`;
  };
  const inner = renderUpdate(update.body, { pill })
    .replace(/<h3>/g, '<h3 style="font-size:16px;margin:22px 0 6px;color:#1c2b3a">')
    .replace(/<ul>/g, '<ul style="margin:6px 0 10px;padding-left:20px">')
    .replace(/<li>/g, '<li style="margin:4px 0">')
    .replace(/<p>/g, '<p style="margin:8px 0">');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1c2b3a;max-width:640px">` +
    (greeting ? `<p style="margin:0 0 10px">${esc(greeting)}</p>` : '') +
    inner +
    (signoff ? `<p style="margin:20px 0 0">${esc(signoff).replace(/\n/g, '<br>')}</p>` : '') +
    `</div>`;
}

module.exports = { renderUpdate, renderUpdateEmail };
