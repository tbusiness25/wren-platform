'use strict';
/* Haven shell — auth guard, fetch helper, nav, modal, toast. */
const Haven = {
  token() { return sessionStorage.getItem('haven_token'); },
  user() { try { return JSON.parse(sessionStorage.getItem('haven_user') || 'null'); } catch { return null; } },

  // Mirror of editions/haven/lib/permissions.js — UI hint only, server enforces.
  PERMS: {
    basic_write:    ['carer', 'nurse', 'senior_carer', 'manager', 'deputy_manager', 'admin'],
    clinical_write: ['nurse', 'senior_carer', 'manager', 'deputy_manager'],
    senior_write:   ['nurse', 'manager', 'deputy_manager'],
    admin_write:    ['manager', 'deputy_manager'],
  },
  can(perm) {
    const u = Haven.user();
    return !!u && (Haven.PERMS[perm] || []).includes(u.role);
  },
  // Hide an action button when the role can't use it (server still enforces)
  gateBtn(id, perm) {
    const el = document.getElementById(id);
    if (el && !Haven.can(perm)) el.style.display = 'none';
    return !!el && Haven.can(perm);
  },

  guard() {
    if (!Haven.token()) { location.href = '/login'; return false; }
    return true;
  },

  logout() {
    sessionStorage.removeItem('haven_token');
    sessionStorage.removeItem('haven_user');
    location.href = '/login';
  },

  async api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + Haven.token(),
        ...(opts.headers || {}),
      },
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    if (res.status === 401) { Haven.logout(); throw new Error('Session expired'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  },
  fmtDateTime(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
      dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  },

  badge(text, cls) {
    return `<span class="hv-badge ${cls || 'neutral'}">${Haven.esc(String(text).replace(/_/g, ' '))}</span>`;
  },

  toast(msg, isError) {
    const el = document.createElement('div');
    el.className = 'hv-toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  },

  modal(title, bodyHtml, onSubmit, submitLabel) {
    const bk = document.createElement('div');
    bk.className = 'hv-modal-backdrop';
    bk.innerHTML = `<div class="hv-modal"><h2>${Haven.esc(title)}</h2>
      <form>${bodyHtml}
      <div class="modal-actions">
        <button type="button" class="hv-btn secondary" data-close>Cancel</button>
        <button type="submit" class="hv-btn">${Haven.esc(submitLabel || 'Save')}</button>
      </div></form></div>`;
    document.body.appendChild(bk);
    bk.addEventListener('click', e => { if (e.target === bk || e.target.hasAttribute('data-close')) bk.remove(); });
    bk.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = {};
      bk.querySelectorAll('[name]').forEach(inp => {
        if (inp.type === 'checkbox') fd[inp.name] = inp.checked;
        else if (inp.value !== '') fd[inp.name] = inp.value;
      });
      try { await onSubmit(fd, bk); bk.remove(); }
      catch (err) { Haven.toast(err.message, true); }
    });
    return bk;
  },

  shell(active) {
    const u = Haven.user() || {};
    const nav = [
      ['Dashboard', '/', 'dashboard'],
      ['Residents', '/residents', 'residents'],
      ['sep', 'Records'],
      ['Incidents', '/incidents', 'incidents'],
      ['Safeguarding', '/safeguarding', 'safeguarding'],
      ['CQC notifications', '/cqc', 'cqc'],
      ['CD register', '/cd-register', 'cd'],
      ['Handover', '/handover', 'handover'],
      ['sep', 'Team'],
      ['Staff', '/staff', 'staff'],
      ['Rota', '/rota', 'rota'],
    ];
    const links = nav.map(n => n[0] === 'sep'
      ? `<div class="nav-sep">${n[1]}</div>`
      : `<a href="${n[1]}" class="${n[2] === active ? 'active' : ''}">${n[0]}</a>`).join('');
    document.body.insertAdjacentHTML('afterbegin', `
      <div class="hv-shell">
        <aside class="hv-sidebar">
          <div class="hv-logo">Ha<span>v</span>en</div>
          <div class="hv-tagline">Care records</div>
          <nav class="hv-nav">${links}</nav>
          <div class="hv-user"><b>${Haven.esc((u.first_name || '') + ' ' + (u.last_name || ''))}</b>
            ${Haven.esc(u.role || '')}<br><button onclick="Haven.logout()">Sign out</button></div>
        </aside>
        <main class="hv-main" id="hv-main"></main>
      </div>`);
    // move any pre-existing page content template into main
    const tpl = document.getElementById('page');
    if (tpl) document.getElementById('hv-main').appendChild(tpl.content.cloneNode(true));
  },
};
window.Haven = Haven;
