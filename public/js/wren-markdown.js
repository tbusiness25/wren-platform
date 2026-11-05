/* wren-markdown.js — b352. A small, SAFE markdown renderer for reading documents in place.
 *
 *   WrenMarkdown.render(text)   -> an HTML string
 *
 * Safe by construction, not by filtering: every character of the source is HTML-escaped before any markup
 * is added, so nothing in a document can become a tag, an attribute or a script. Links are limited to
 * http(s) and mailto; an image is never fetched (it is shown as "[image: alt]"), so opening a document
 * cannot make the browser call out to anywhere.
 *
 * Handles what Wren's analyses actually use: headings, paragraphs, bold / italic / code / strike, fenced
 * code, block quotes, rules, nested bullet and numbered lists, and pipe tables. Runs in the browser and in
 * node (scripts/b352-verify.js tests it there).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WrenMarkdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function safeLink(label, url) {
    // url is already HTML-escaped by the time it gets here.
    if (/^(https?:\/\/|mailto:)/i.test(url)) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    }
    // Not a link we will follow. The target is shown as a tooltip only when it is a plain relative reference; a
    // javascript:/data:/vbscript: target is dropped entirely so it appears nowhere in the output.
    const tip = /^(javascript|data|vbscript):/i.test(url) ? '' : ' title="' + url + '"';
    return '<span class="rr-ref"' + tip + '>' + label + '</span>';
  }

  function inline(src) {
    const codes = [];
    let t = String(src).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0001' + (codes.length - 1) + '\u0001'; });
    t = esc(t);
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*?&quot;)?\)/g, (_, alt) => '<span class="rr-img">[image' + (alt ? ': ' + alt : '') + ']</span>');
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*?&quot;)?\)/g, (_, label, url) => safeLink(label, url));
    t = t.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w])__([^_\n]+?)__(?!\w)/g, '$1<strong>$2</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?![_\w])/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    t = t.replace(/(^|[\s(>])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (m, pre, url) => pre + safeLink(url, url));
    t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => '<code>' + esc(codes[+i]) + '</code>');
    return t;
  }

  const isBlank = l => !/\S/.test(l);
  const RE_FENCE = /^\s*```/;
  const RE_HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const RE_QUOTE = /^\s{0,3}>\s?/;
  const RE_LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
      else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
      else cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  function renderLists(lines, i, out) {
    // Build a nested tree from indentation, then emit it.
    const items = [];
    while (i < lines.length) {
      const m = lines[i].match(RE_LI);
      if (m) { items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3], kids: [] }); i++; continue; }
      if (!isBlank(lines[i]) && items.length && /^\s+\S/.test(lines[i]) && !RE_FENCE.test(lines[i]) && !RE_TABLE_SEP.test(lines[i]) && lines[i].indexOf('|') !== 0 && !/^\s*\|/.test(lines[i])) {
        items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue;      // a wrapped item
      }
      if (isBlank(lines[i]) && i + 1 < lines.length && RE_LI.test(lines[i + 1]) && items.length) { i++; continue; }   // a loose list
      break;
    }
    const root = { kids: [], indent: -1 };
    const stack = [root];
    for (const it of items) {
      while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
      stack[stack.length - 1].kids.push(it);
      stack.push(it);
    }
    const emit = kids => {
      // a run of bullets followed by a run of numbers is two lists, not one
      let html = '', run = [];
      const flush = () => {
        if (!run.length) return;
        const tag = run[0].ordered ? 'ol' : 'ul';
        html += '<' + tag + '>' + run.map(k => '<li>' + inline(k.text) + emit(k.kids) + '</li>').join('') + '</' + tag + '>';
        run = [];
      };
      for (const k of kids) { if (run.length && run[0].ordered !== k.ordered) flush(); run.push(k); }
      flush();
      return html;
    };
    out.push(emit(root.kids));
    return i;
  }

  function render(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      if (RE_FENCE.test(line)) {
        const buf = []; i++;
        while (i < lines.length && !RE_FENCE.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      const h = line.match(RE_HEAD);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

      if (RE_QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && (RE_QUOTE.test(lines[i]) || (!isBlank(lines[i]) && buf.length && !RE_HEAD.test(lines[i])))) buf.push(lines[i++].replace(RE_QUOTE, ''));
        out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
        continue;
      }

      if (line.indexOf('|') !== -1 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf('|') !== -1) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map(c => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') !== -1) rows.push(splitRow(lines[i++]));
        const cell = (tag, c, n) => '<' + tag + (align[n] ? ' style="text-align:' + align[n] + '"' : '') + '>' + inline(c) + '</' + tag + '>';
        out.push('<div class="rr-table"><table><thead><tr>' + head.map((c, n) => cell('th', c, n)).join('') + '</tr></thead><tbody>'
          + rows.map(r => '<tr>' + head.map((_, n) => cell('td', r[n] == null ? '' : r[n], n)).join('') + '</tr>').join('')
          + '</tbody></table></div>');
        continue;
      }

      if (RE_LI.test(line)) { i = renderLists(lines, i, out); continue; }

      // paragraph: runs until a blank line or the start of another block
      const buf = [];
      while (i < lines.length && !isBlank(lines[i]) && !RE_FENCE.test(lines[i]) && !RE_HEAD.test(lines[i]) && !RE_HR.test(lines[i])
             && !RE_QUOTE.test(lines[i]) && !RE_LI.test(lines[i])
             && !(lines[i].indexOf('|') !== -1 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf('|') !== -1)) buf.push(lines[i++].trim());
      if (buf.length) out.push('<p>' + inline(buf.join(' ')) + '</p>');
      else i++;     // a line no rule claimed: never loop on it
    }
    return out.join('\n');
  }

  /** A CSV as a table, capped, every cell escaped. */
  function renderCsv(text, maxRows) {
    const cap = maxRows || 300;
    const rows = []; let row = [], cur = '', q = false;
    const s = String(text || '').replace(/\r\n?/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; if (rows.length > cap + 1) break; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    if (!rows.length) return '<p class="rr-empty">Empty file.</p>';
    const head = rows[0], body = rows.slice(1, cap + 1);
    return '<div class="rr-table"><table><thead><tr>' + head.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>'
      + body.map(r => '<tr>' + head.map((_, n) => '<td>' + esc(r[n] == null ? '' : r[n]) + '</td>').join('') + '</tr>').join('')
      + '</tbody></table></div>' + (rows.length - 1 > cap ? '<p class="rr-empty">Showing the first ' + cap + ' rows.</p>' : '');
  }

  return { render, renderCsv, esc, inline };
});
