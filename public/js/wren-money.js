'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b397 (2026-10-05, DEV ONLY) — Invoices & Payments (editions/admin/public/money.html).
// EyMan-shaped: one list per job, a few obvious buttons. The money RULES are not
// reinvented here — every write goes through the existing endpoints
// (src/routes/finance-invoices.js, src/routes/finance-payments.js) or the family
// ledger (src/lib/family-ledger.js via /api/payments-admin/ledger). This file is
// just the screen.
//
// b401 (2026-10-06) — wrapped in an IIFE: this file is now also loaded on the child
// profile page (editions/admin/public/child-profile.html), which has its own global
// `api`/`esc` of its own. Without this wrapper, loading both on one page throws
// "Identifier 'api' has already been declared" and this entire script never runs —
// every button it exposes (Add payment, Credit note…) silently does nothing. Only
// `window.WrenMoney` is meant to be visible outside this file; everything else here
// already was effectively private, just not enforced.
// ─────────────────────────────────────────────────────────────────────────────
(function () {

const api = (u, o) => Wren.api(u, o);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (p) => '£' + ((p || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const errText = (e, fb) => (e && (e.error || e.message)) || fb || 'Something went wrong';
// A pg DATE / 'YYYY-MM-DD' straight from the server, parsed with local getters —
// never `new Date(ymd)`, which reads it as UTC and can show the day before.
function ymdPretty(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(ymd);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function toast(msg, kind) { Wren.toast(msg, kind); }

// ── a tiny Wren.modal() wrapper that resolves true/false, because on Roost
// standalone pages Wren.modal() returns the overlay element, not a Promise.
// (reference_roost_modal_returns_element_not_promise) ─────────────────────────
function ask(title, html, okLabel) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    Wren.modal(title, html, [
      { label: 'Cancel', action: () => finish(false) },
      { label: okLabel, class: 'btn-primary', action: () => finish(true) },
    ]);
  });
}
function formModal(title, html, okLabel, onSave) {
  Wren.modal(title, html, [
    { label: 'Cancel', action: () => {} },
    { label: okLabel, class: 'btn-primary', close: false, action: (ev) => onSave(ev) },
  ]);
}
function closeModal() {
  document.querySelectorAll('.wren-modal-overlay .modal-close').forEach(b => b.click());
}

// ══ CHILD PICKER — a small reusable typeahead ════════════════════════════════
// Renders an <input> + results list into `mountEl`; calls onPick({id, name}) when
// a result is chosen. Used by Add payment / Add credit note / Families search.
function mountChildPicker(mountEl, onPick, placeholder) {
  mountEl.innerHTML = `
    <input type="text" class="mny-child-input" placeholder="${esc(placeholder || 'Search a child…')}" autocomplete="off">
    <div class="mny-child-results" style="display:none;border:1px solid var(--c-border);border-radius:8px;
      margin-top:4px;max-height:160px;overflow:auto;background:var(--c-surface)"></div>
    <input type="hidden" class="mny-child-id">`;
  const input = mountEl.querySelector('.mny-child-input');
  const results = mountEl.querySelector('.mny-child-results');
  const hidden = mountEl.querySelector('.mny-child-id');
  let t = null;
  input.addEventListener('input', () => {
    hidden.value = '';
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2) { results.style.display = 'none'; return; }
    t = setTimeout(() => {
      api('/api/children/search?q=' + encodeURIComponent(q) + '&limit=8').then(d => {
        const rows = d.results || [];
        if (!rows.length) { results.innerHTML = '<div style="padding:8px;font-size:.8rem;color:var(--c-muted)">No match</div>'; results.style.display = 'block'; return; }
        results.innerHTML = rows.map(c => `<div class="mny-child-row" data-id="${c.id}" data-name="${esc(c.first_name + ' ' + c.last_name)}"
          style="padding:7px 10px;font-size:.82rem;cursor:pointer;border-bottom:1px solid var(--c-border)">
          ${esc(c.first_name)} ${esc(c.last_name)} <span style="color:var(--c-muted)">· ${esc(c.room_name || '')}</span></div>`).join('');
        results.style.display = 'block';
        results.querySelectorAll('.mny-child-row').forEach(row => row.addEventListener('click', () => {
          input.value = row.dataset.name; hidden.value = row.dataset.id;
          results.style.display = 'none';
          onPick({ id: parseInt(row.dataset.id, 10), name: row.dataset.name });
        }));
      }).catch(() => {});
    }, 220);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// INVOICES
// ══════════════════════════════════════════════════════════════════════════
let INV_ROWS = [];

function paymentStatusOf(inv) {
  const amt = Number(inv.amount_pence) || 0;
  const paid = Number(inv.paid_pence) || 0;
  if (amt < 0) return { key: 'credit', label: 'Credit' };
  if (paid <= 0) return { key: 'unpaid', label: 'Unpaid' };
  if (paid >= amt) return { key: 'paid', label: 'Paid' };
  return { key: 'part', label: 'Part-paid' };
}
const INV_STATUS_PILL = {
  draft: 'plain', sent: 'info', paid: 'ok', overdue: 'bad', written_off: 'plain', credit_note: 'warn',
};
function pill(label, kind) { return `<span class="mny-pill ${kind}">${esc(label)}</span>`; }

function invFilterQS() {
  const p = new URLSearchParams();
  const year = document.getElementById('inv-f-year').value;
  const month = document.getElementById('inv-f-month').value;
  const mode = document.getElementById('inv-f-mode').value;
  const status = document.getElementById('inv-f-status').value;
  const q = document.getElementById('inv-f-q').value.trim();
  if (year) p.set('year', year);
  if (month) p.set('month', month);
  if (mode) p.set('payment_mode', mode);
  if (status) p.set('status', status);
  if (q) {
    if (/^INV-/i.test(q)) p.set('invoice_number', q); else p.set('child_name', q);
  }
  p.set('limit', '500');
  return p.toString();
}

function loadInvoices() {
  const tbody = document.getElementById('inv-tbody');
  // b401 (2026-10-06) — openInvoiceDetail()/writeOffInvoice()/regenerateInvoice() fall back to
  // calling this when no onDone was given a caller outside the Money page (the child profile's
  // Funding & Invoices tab has no #inv-tbody) must not crash on that fallback.
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="12" class="mny-empty">Loading…</td></tr>';
  api('/api/finance/invoices/?' + invFilterQS()).then(d => {
    INV_ROWS = d.invoices || [];
    const payStatusFilter = document.getElementById('inv-f-paystatus').value;
    const rows = payStatusFilter ? INV_ROWS.filter(r => paymentStatusOf(r).key === payStatusFilter) : INV_ROWS;
    renderInvoices(rows);
  }).catch(e => { tbody.innerHTML = `<tr><td colspan="12" class="mny-empty">${esc(errText(e, 'Could not load invoices'))}</td></tr>`; });
}

function renderInvoices(rows) {
  const tbody = document.getElementById('inv-tbody');
  const totalEl = document.getElementById('inv-total');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="12" class="mny-empty">No invoices match.</td></tr>'; totalEl.textContent = ''; return; }
  tbody.innerHTML = rows.map(r => {
    const ps = paymentStatusOf(r);
    const psKind = ps.key === 'paid' ? 'ok' : ps.key === 'part' ? 'warn' : ps.key === 'credit' ? 'info' : 'bad';
    return `<tr class="mny-row-link" data-id="${r.id}">
      <td><input type="checkbox" class="inv-row-sel" data-id="${r.id}" ${r.sent_at ? '' : ''}></td>
      <td>${r.period_year || ''}</td><td>${r.period_month ? MONTH_NAMES[r.period_month] : ''}</td>
      <td>${esc(r.child_name || '—')}</td>
      <td class="mny-muted">${esc(r.payment_method || '—')}</td>
      <td class="mny-muted">${esc(r.invoice_number || '#' + r.id)}</td>
      <td>${ymdPretty(r.issued_on)}</td><td>${ymdPretty(r.due_on)}</td>
      <td class="num">${fmt(r.amount_pence)}</td>
      <td class="num">${fmt(r.balance_pence)}</td>
      <td>${pill(ps.label, psKind)}</td>
      <td>${pill(r.status.replace('_', ' '), INV_STATUS_PILL[r.status] || 'plain')}</td>
      <td>${r.sent_at ? '✓' : '—'}</td>
    </tr>`;
  }).join('');
  const total = rows.reduce((s, r) => s + (Number(r.amount_pence) || 0), 0);
  const bal = rows.reduce((s, r) => s + (Number(r.balance_pence) || 0), 0);
  totalEl.textContent = `${rows.length} invoice${rows.length === 1 ? '' : 's'} · total ${fmt(total)} · outstanding ${fmt(bal)}`;
  tbody.querySelectorAll('tr').forEach(tr => tr.addEventListener('click', (e) => {
    if (e.target.classList.contains('inv-row-sel')) return;
    openInvoiceDetail(parseInt(tr.dataset.id, 10));
  }));
  updateInvSelCount();
}

function selectedInvoiceIds() {
  return [...document.querySelectorAll('.inv-row-sel:checked')].map(c => parseInt(c.dataset.id, 10));
}
function updateInvSelCount() {
  const n = selectedInvoiceIds().length;
  document.getElementById('inv-sel-count').textContent = n ? `${n} selected` : '';
}

// b401 (2026-10-06) — `opts.onDone` lets a caller that is not the Money page (the child
// profile's Funding & Invoices tab) refresh ITS OWN tables instead of the Money page's
// #inv-tbody, which it does not have. Money page callers are unchanged: no onDone, so this
// falls back to loadInvoices(), exactly as before.
function openInvoiceDetail(id, opts = {}) {
  const onDone = opts.onDone || loadInvoices;
  api('/api/finance/invoices/' + id).then(inv => {
    const ps = paymentStatusOf(inv);
    const lines = (inv.line_items || []).map(li => `<tr><td>${esc(li.label || '')}</td>
      <td class="num">${fmt(li.amount_pence)}</td></tr>`).join('');
    const locked = !!(inv.locked_at || inv.sent_at) || inv.status !== 'draft' || !!inv.eylog_ref;
    // b490 — a sent/overdue/paid invoice (not an EyLog import, not already reissued) can be
    // reissued: same eligibility reissueGuard enforces server-side, just mirrored here so the
    // button only appears when the action would actually succeed.
    const canReissue = !inv.eylog_ref && !inv.reissued_as && ['sent', 'overdue', 'paid'].includes(inv.status);
    Wren.modal(`${esc(inv.invoice_number || '#' + inv.id)} — ${esc(inv.child_name || '')}`, `
      <div style="font-size:.85rem;display:flex;flex-direction:column;gap:10px">
        <div class="mny-muted">${esc(inv.period_label || '')} · issued ${ymdPretty(inv.issued_on)} · due ${ymdPretty(inv.due_on)}</div>
        <div>${pill(ps.label, 'info')} ${pill(inv.status.replace('_', ' '), INV_STATUS_PILL[inv.status] || 'plain')}</div>
        ${inv.reissued_as ? `<div class="mny-hint">Already reissued as <b>${esc(inv.reissued_as.invoice_number || '#' + inv.reissued_as.id)}</b>.</div>` : ''}
        <table class="mny-alloc-table"><thead><tr><th>Line</th><th class="num">Amount</th></tr></thead>
          <tbody>${lines || '<tr><td colspan="2" class="mny-muted">No line items recorded.</td></tr>'}</tbody>
          <tfoot><tr><td><b>Total</b></td><td class="num"><b>${fmt(inv.amount_pence)}</b></td></tr></tfoot></table>
        ${(inv.payment_history || []).length ? `<div><b>Payments</b></div>
          <table class="mny-alloc-table"><tbody>${inv.payment_history.map(p =>
            `<tr><td>${esc(p.payment_method || '')} · ${esc(p.description || '')}</td><td class="num">${fmt(p.amount_pence)}</td></tr>`).join('')}
          </tbody></table>` : ''}
      </div>`, [
      { label: 'Close' },
      { label: '📄 PDF', action: () => Wren.download(`/api/finance/invoices/${id}/pdf`, (inv.invoice_number || 'invoice') + '.pdf').catch(e => toast(errText(e), 'warning')) },
      { label: 'Record payment…', action: () => openAddPaymentModal({ childId: inv.child_id, childName: inv.child_name, applyTo: 'invoice', invoiceId: inv.id, onDone }) },
      { label: 'Credit note…', action: () => openCreditNoteModal({ childId: inv.child_id, childName: inv.child_name, invoiceId: inv.id, onDone }) },
      ...(inv.status !== 'written_off' && inv.status !== 'credit_note' ? [{ label: 'Write off…', action: () => writeOffInvoice(id, onDone) }] : []),
      ...(!locked ? [{ label: 'Regenerate…', action: () => regenerateInvoice(id, onDone) }] : []),
      ...(canReissue ? [{ label: 'Reissue…', action: () => openReissuePreviewModal(id, onDone) }] : []),
    ]);
  }).catch(e => toast(errText(e, 'Could not load that invoice'), 'warning'));
}

function writeOffInvoice(id, onDone) {
  onDone = onDone || loadInvoices;
  ask('Write off this invoice', '<p>This marks the invoice written off. It stays on the record — nothing is deleted.</p>', 'Write off').then(ok => {
    if (!ok) return;
    api(`/api/finance/invoices/${id}/write-off`, { method: 'POST', body: {} })
      .then(() => { toast('Invoice written off', 'success'); onDone(); })
      .catch(e => toast(errText(e), 'warning'));
  });
}
function regenerateInvoice(id, onDone) {
  onDone = onDone || loadInvoices;
  ask('Regenerate this invoice', '<p>Recalculates this draft from the child’s current booking and funding. Only possible before it has been sent.</p>', 'Regenerate').then(ok => {
    if (!ok) return;
    api(`/api/finance/invoices/${id}/regenerate`, { method: 'POST', body: {} })
      .then(() => { toast('Invoice regenerated', 'success'); onDone(); })
      .catch(e => toast(errText(e), 'warning'));
  });
}

// b490 — "reissue" an already-sent invoice: preview what today's bookings/prices/
// overrides would charge for the SAME period, side by side with what was actually
// billed, before anything is written. Confirming calls POST /reissue, which credits
// the old invoice in full and raises a new draft (see src/routes/finance-invoices.js).
function openReissuePreviewModal(id, onDone) {
  onDone = onDone || loadInvoices;
  api(`/api/finance/invoices/${id}/reissue/preview`, { method: 'POST', body: {} }).then(d => {
    const oldLines = (d.old.line_items || []).map(li => `<tr><td>${esc(li.label || '')}</td>
      <td class="num">${fmt(li.amount_pence)}</td></tr>`).join('');
    const newLines = (d.new.line_items || []).map(li => `<tr><td>${esc(li.label || '')}${li.price_overridden ? ' <span class="mny-pill info" style="font-size:.64rem">price changed</span>' : ''}</td>
      <td class="num">${fmt(li.amount_pence)}</td></tr>`).join('');
    const diff = d.difference_pence || 0;
    formModal('Reissue ' + esc(d.old.invoice_number || '#' + id), `
      <div class="mny-form" style="font-size:.85rem">
        <p class="mny-hint">Credits ${esc(d.old.invoice_number || 'the old invoice')} in full and raises a new draft for the
          same period (${esc(d.old.period_label || '')}) from today's bookings, prices and any active price override.
          Any payments already recorded move onto the new invoice. The replacement is billed but not emailed —
          send it from the normal send flow.</p>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div style="flex:1 1 220px;min-width:200px">
            <div class="mny-h2" style="font-size:.78rem;margin-bottom:6px">Old (${esc(d.old.invoice_number || '#' + id)})</div>
            <table class="mny-alloc-table"><tbody>${oldLines || '<tr><td colspan="2" class="mny-muted">No lines</td></tr>'}</tbody>
              <tfoot><tr><td><b>Total</b></td><td class="num"><b>${fmt(d.old.amount_pence)}</b></td></tr></tfoot></table>
          </div>
          <div style="flex:1 1 220px;min-width:200px">
            <div class="mny-h2" style="font-size:.78rem;margin-bottom:6px">New (today's figures)</div>
            <table class="mny-alloc-table"><tbody>${newLines || '<tr><td colspan="2" class="mny-muted">No lines</td></tr>'}</tbody>
              <tfoot><tr><td><b>Total</b></td><td class="num"><b>${fmt(d.new.amount_pence)}</b></td></tr></tfoot></table>
          </div>
        </div>
        ${d.old.credited_pence ? `<div class="mny-hint">${fmt(d.old.credited_pence)} has already been credited against ${esc(d.old.invoice_number || 'the old invoice')} — only the rest is credited now.</div>` : ''}
        <div class="mny-hint"><b>Difference: ${diff === 0 ? 'none' : (diff > 0 ? '+' : '') + fmt(diff)}</b></div>
        <label><span>Reason (shown on the audit trail)</span><input type="text" id="ri-reason" placeholder="e.g. Room move + price change for ${esc(d.old.period_label || 'this month')}"></label>
      </div>`, 'Reissue', () => submitReissue(id, onDone));
  }).catch(e => toast(errText(e, 'Could not preview this reissue'), 'warning'));
}
function submitReissue(id, onDone) {
  const reason = (document.getElementById('ri-reason') || {}).value?.trim() || undefined;
  api(`/api/finance/invoices/${id}/reissue`, { method: 'POST', body: { reason } }).then(d => {
    closeModal();
    toast(`Reissued — credit note ${d.credit_note_invoice_number || ''}, new invoice ${d.replacement_invoice_number || ''} (not emailed yet)`, 'success');
    onDone();
    openInvoiceDetail(d.replacement_id, { onDone });
  }).catch(e => toast(errText(e, 'Could not reissue that invoice'), 'warning'));
}

// b490 — manager-set per-child, per-period price override (child_price_overrides).
// Lists what's on file for this child and lets a manager add/retire one. Read by
// both billing engines (src/lib/price-overrides.js), so a value set here shows up
// identically in Generate/Regenerate/the Income Forecast and a Reissue preview.
function openPriceOverrideModal(opts = {}) {
  const { childId, childName, onDone } = opts;
  const done = onDone || (() => {});
  api('/api/finance/invoices/price-overrides?child_id=' + childId).then(d => {
    renderPriceOverrideModal(childId, childName, d.overrides || [], done);
  }).catch(e => toast(errText(e, 'Could not load price overrides'), 'warning'));
}
function renderPriceOverrideModal(childId, childName, overrides, onDone) {
  const now = new Date();
  const monthStart = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
  const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const rows = overrides.map(o => `<tr${o.active ? '' : ' style="opacity:.55"'}>
      <td>${ymdPretty(o.from_date)} – ${ymdPretty(o.to_date)}</td>
      <td class="num">${fmt(o.price_pence)}/${esc(o.unit)}</td>
      <td class="mny-muted">${esc(o.reason || '—')}</td>
      <td>${o.active ? pill('Active', 'ok') : pill('Retired', 'plain')}</td>
      <td>${o.active ? `<button type="button" class="mny-btn" style="font-size:.7rem;padding:3px 8px" data-po-deactivate="${o.id}">Retire</button>` : ''}</td>
    </tr>`).join('');
  formModal('Change price' + (childName ? ' — ' + esc(childName) : ''), `
    <div class="mny-form" style="font-size:.85rem">
      <p class="mny-hint">Overrides the catalogue day rate for this child for a billing month, without touching their
        funding. Shows on the invoice line as "price changed". Used by Generate, Regenerate, the Income Forecast and
        Reissue — one figure, everywhere.</p>
      <table class="mny-alloc-table"><thead><tr><th>Period</th><th class="num">Price</th><th>Reason</th><th>Status</th><th></th></tr></thead>
        <tbody id="po-rows">${rows || '<tr><td colspan="5" class="mny-muted">No price overrides on file.</td></tr>'}</tbody>
      </table>
      <div style="border-top:1px solid var(--c-border);margin-top:4px;padding-top:12px">
        <div class="mny-h2" style="font-size:.78rem;margin-bottom:6px">Add a new override</div>
        <label><span>Billing month</span>
          <select id="po-month">${[-1, 0, 1, 2].map(off => {
            const d = new Date(now.getFullYear(), now.getMonth() + off, 1);
            return `<option value="${d.getFullYear()}-${d.getMonth() + 1}"${off === 0 ? ' selected' : ''}>${d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</option>`;
          }).join('')}</select>
        </label>
        <label><span>From</span><input type="date" id="po-from"></label>
        <label><span>To</span><input type="date" id="po-to"></label>
        <label><span>Day rate (£)</span><input type="number" id="po-price" step="0.01" min="0" placeholder="e.g. 97.00"></label>
        <label><span>Reason</span><input type="text" id="po-reason" placeholder="e.g. Moved to Pre-school 21 Sep, billed at the Pre-school rate for October"></label>
      </div>
    </div>`, 'Add override', () => submitPriceOverride(childId, childName, onDone));
  const monthSel = document.getElementById('po-month');
  const fromEl = document.getElementById('po-from'), toEl = document.getElementById('po-to');
  const fillMonth = () => {
    const [y, m] = monthSel.value.split('-').map(Number);
    fromEl.value = monthStart(y, m); toEl.value = monthEnd(y, m);
  };
  monthSel.addEventListener('change', fillMonth);
  fillMonth();
  document.querySelectorAll('[data-po-deactivate]').forEach(btn => btn.addEventListener('click', () => {
    api(`/api/finance/invoices/price-overrides/${btn.dataset.poDeactivate}/deactivate`, { method: 'POST', body: {} })
      .then(() => { toast('Price override retired', 'success'); closeModal(); openPriceOverrideModal({ childId, childName, onDone }); onDone(); })
      .catch(e => toast(errText(e), 'warning'));
  }));
}
function submitPriceOverride(childId, childName, onDone) {
  const price = parseFloat(document.getElementById('po-price').value || '');
  const fromDate = document.getElementById('po-from').value;
  const toDate = document.getElementById('po-to').value;
  if (!(price >= 0)) { toast('Enter a day rate (£0 or more)', 'warning'); return; }
  if (!fromDate || !toDate) { toast('Pick a date range', 'warning'); return; }
  api('/api/finance/invoices/price-overrides', { method: 'POST', body: {
    child_id: childId, unit: 'day', price_pence: Math.round(price * 100),
    from_date: fromDate, to_date: toDate,
    reason: document.getElementById('po-reason').value.trim() || null,
  } }).then(() => {
    closeModal(); toast('Price override added', 'success');
    onDone();
    openPriceOverrideModal({ childId, childName, onDone });
  }).catch(e => toast(errText(e, 'Could not add that price override'), 'warning'));
}

function openGenerateModal() {
  const now = new Date();
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  Wren.modal('Generate invoices for a month', `
    <div class="mny-form">
      <label><span>Year</span><select id="gi-year">${years.map(y => `<option value="${y}" ${y === now.getFullYear() ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <label><span>Month</span><select id="gi-month">${MONTH_NAMES.slice(1).map((m, i) => `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <p class="mny-hint">Preview first — nothing is created until you confirm.</p>
      <div id="gi-preview"></div>
    </div>`, [
    { label: 'Close' },
    { label: 'Preview', close: false, action: () => runGenerate(true) },
  ]);
}
function runGenerate(preview) {
  const year = parseInt(document.getElementById('gi-year').value, 10);
  const month = parseInt(document.getElementById('gi-month').value, 10);
  const box = document.getElementById('gi-preview');
  box.innerHTML = '<p class="mny-muted">Working…</p>';
  // 2026-10-09: the whole-nursery run uses POST /generate — the generator October was raised
  // with (funding taken off at our hourly rate). generate-itemised now routes there too.
  api('/api/finance/invoices/generate', { method: 'POST', body: { year, month, preview } })
    .then(d => {
      const list = d.invoices || [];
      const withAmount = list.filter(r => (r.amount_pence || 0) > 0).length;
      if (preview) {
        box.innerHTML = `<p><b>${list.length}</b> invoice(s) would be created, <b>${withAmount}</b> of them for more than £0.00.
          Total ${fmt(list.reduce((s, r) => s + (r.amount_pence || 0), 0))}.</p>
          <button class="mny-btn mny-btn-primary" id="gi-confirm" type="button">Generate ${list.length} invoice(s)</button>`;
        document.getElementById('gi-confirm').addEventListener('click', () => runGenerate(false));
      } else {
        box.innerHTML = `<p>${pill('Done', 'ok')} ${list.length} invoice(s) created.</p>`;
        toast(`${list.length} invoices generated`, 'success');
        loadInvoices();
      }
    })
    .catch(e => { box.innerHTML = `<p style="color:var(--c-danger)">${esc(errText(e, 'Could not generate'))}</p>`; });
}

function initInvoices() {
  const yearSel = document.getElementById('inv-f-year');
  const now = new Date().getFullYear();
  yearSel.innerHTML = '<option value="">All years</option>' +
    [now + 1, now, now - 1, now - 2].map(y => `<option value="${y}" ${y === now ? 'selected' : ''}>${y}</option>`).join('');
  document.getElementById('btn-inv-search').addEventListener('click', loadInvoices);
  document.getElementById('inv-f-q').addEventListener('keydown', e => { if (e.key === 'Enter') loadInvoices(); });
  document.getElementById('inv-f-paystatus').addEventListener('change', loadInvoices);
  document.getElementById('btn-inv-generate').addEventListener('click', openGenerateModal);
  // b535 — the "Out of date (N)" chip. Counted on open, re-counted after any bulk action.
  const staleChip = document.getElementById('inv-stale-chip');
  if (staleChip) {
    const refreshChip = () => loadStaleChip(staleChip);
    staleChip.addEventListener('click', () => openStaleModal({ onDone: () => { refreshChip(); loadInvoices(); } }));
    refreshChip();
  }
  // 2026-10-06 — the old Finance "Generate Invoices" button sends people here (#generate).
  if (location.hash === '#generate') setTimeout(openGenerateModal, 300);
  document.getElementById('inv-sel-all').addEventListener('change', (e) => {
    document.querySelectorAll('.inv-row-sel').forEach(c => { c.checked = e.target.checked; });
    updateInvSelCount();
  });
  document.getElementById('inv-tbody').addEventListener('change', (e) => { if (e.target.classList.contains('inv-row-sel')) updateInvSelCount(); });
  document.getElementById('btn-inv-send-selected').addEventListener('click', () => {
    const ids = selectedInvoiceIds();
    if (!ids.length) { toast('Select at least one invoice', 'warning'); return; }
    ask('Send selected invoices', `<p>Emails ${ids.length} invoice(s) to their bill payer, with a PDF attached. Already-sent ones are skipped unless resent.</p>`, 'Send').then(ok => {
      if (!ok) return;
      api('/api/finance/invoices/send', { method: 'POST', body: { invoice_ids: ids } })
        .then(d => { toast(`Sent ${d.sent}, failed ${d.failed}`, d.failed ? 'warning' : 'success'); loadInvoices(); })
        .catch(e => toast(errText(e), 'warning'));
    });
  });
  loadInvoices();
}

// ══════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ══════════════════════════════════════════════════════════════════════════
function payFilterQS() {
  const p = new URLSearchParams();
  const q = document.getElementById('pay-f-q').value.trim();
  const mode = document.getElementById('pay-f-mode').value;
  const status = document.getElementById('pay-f-status').value;
  const locked = document.getElementById('pay-f-locked').value;
  if (q) p.set('q', q);
  if (mode) p.set('payment_mode', mode);
  if (status) p.set('status', status);
  if (locked) p.set('locked', locked);
  p.set('limit', '200');
  return p.toString();
}
function loadPayments() {
  const tbody = document.getElementById('pay-tbody');
  // b401 — same guard as loadInvoices(): a caller outside the Money page has no #pay-tbody.
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="10" class="mny-empty">Loading…</td></tr>';
  api('/api/finance/payments?' + payFilterQS()).then(d => renderPayments(d.payments || []))
    .catch(e => { tbody.innerHTML = `<tr><td colspan="10" class="mny-empty">${esc(errText(e, 'Could not load payments'))}</td></tr>`; });
}
function renderPayments(rows) {
  const tbody = document.getElementById('pay-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="10" class="mny-empty">No payments match.</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => {
    const on = r.paid_on || r.created_at;
    const d = on ? new Date(on) : null;
    const statusKind = r.status === 'succeeded' ? 'ok' : r.status === 'reversed' ? 'bad' : 'warn';
    return `<tr class="mny-row-link" data-id="${r.id}">
      <td>${d ? d.getFullYear() : ''}</td><td>${d ? MONTH_NAMES[d.getMonth() + 1] : ''}</td>
      <td class="mny-muted">${esc(r.payment_no)}</td><td>${esc(r.child_name || '—')}</td>
      <td>${ymdPretty(String(on).slice(0, 10))}</td><td class="mny-muted">${esc(r.payment_method || '—')}</td>
      <td class="num">${fmt(r.amount_pence)}</td><td class="num">${fmt(r.balance_pence)}</td>
      <td>${r.locked ? '🔒' : ''}</td><td>${pill(r.status, statusKind)}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach(tr => tr.addEventListener('click', () => openPaymentDetail(parseInt(tr.dataset.id, 10))));
}

// b401 — same opts.onDone pattern as openInvoiceDetail(); Money page callers are unchanged.
function openPaymentDetail(id, opts = {}) {
  const onDone = opts.onDone || (() => { loadPayments(); loadInvoices(); });
  api('/api/finance/payments/' + id).then(p => {
    const canEdit = p.source === 'manual' && p.status !== 'reversed';
    const allocRows = (p.allocations || []).map(a => `<tr><td>${esc(a.invoice_number || '#' + a.invoice_id)}</td>
      <td>${ymdPretty(a.invoice_date)}</td><td class="num">${fmt(a.amount_pence)}</td></tr>`).join('');
    Wren.modal(`Payment ${esc(p.payment_no)} — ${esc(p.child_name || '')}`, `
      <div style="font-size:.85rem;display:flex;flex-direction:column;gap:10px">
        <div class="mny-muted">${ymdPretty(String(p.paid_on || p.created_at).slice(0, 10))} · ${esc(p.payment_method || '')} · ${fmt(p.amount_pence)}</div>
        <div>${pill(p.status, p.status === 'succeeded' ? 'ok' : p.status === 'reversed' ? 'bad' : 'warn')} ${p.locked ? pill('Locked — not entered here', 'plain') : pill('Manual entry', 'info')}</div>
        ${p.cash_reference ? `<div>Reference: ${esc(p.cash_reference)}</div>` : ''}
        ${p.manual_notes ? `<div>Notes: ${esc(p.manual_notes)}</div>` : ''}
        <div><b>Allocation</b></div>
        <table class="mny-alloc-table"><thead><tr><th>Invoice</th><th>Date</th><th class="num">Allocated</th></tr></thead>
          <tbody>${allocRows || '<tr><td colspan="3" class="mny-muted">Went straight to the family’s account as credit.</td></tr>'}</tbody></table>
      </div>`, [
      { label: 'Close' },
      ...(canEdit ? [{ label: 'Edit…', action: () => openEditPaymentModal(id, { onDone }) }] : []),
      ...(canEdit ? [{ label: 'Undo (reverse)…', action: () => reversePayment(id, onDone) }] : []),
    ]);
  }).catch(e => toast(errText(e, 'Could not load that payment'), 'warning'));
}
function reversePayment(id, onDone) {
  onDone = onDone || (() => { loadPayments(); loadInvoices(); });
  ask('Undo this payment', '<p>The payment is marked reversed, not deleted, and any invoice it settled goes back to unpaid. Any family credit it created is removed only if nobody has applied it to a bill yet.</p>', 'Undo payment').then(ok => {
    if (!ok) return;
    api(`/api/finance/payments/${id}/reverse`, { method: 'POST', body: {} })
      .then(() => { toast('Payment undone', 'success'); closeModal(); onDone(); })
      .catch(e => toast(errText(e), 'warning'));
  });
}

// ── Edit a manual payment (b401) — date, mode, reference, notes only; the amount was
// already allocated when it was recorded, so PUT /api/finance/payments/:id refuses it. ─────
function openEditPaymentModal(id, opts = {}) {
  const onDone = opts.onDone || loadPayments;
  api('/api/finance/payments/' + id).then(p => {
    if (p.source !== 'manual') { toast('Only a manually-entered payment can be edited here', 'warning'); return; }
    if (p.status === 'reversed') { toast('This payment has been undone', 'warning'); return; }
    const modeOptions = ['Bank transfer', 'Tax-Free Childcare', 'Card', 'Cash', 'Childcare vouchers', 'Direct Debit', 'Deposit', 'Other'];
    const curMode = p.payment_method || '';
    const options = curMode && !modeOptions.includes(curMode) ? [curMode, ...modeOptions] : modeOptions;
    formModal(`Edit payment ${esc(p.payment_no || '')}`, `
      <div class="mny-form">
        <label><span>Date of payment</span><input type="date" id="ep-date" value="${esc(String(p.paid_on || p.created_at || '').slice(0, 10))}"></label>
        <label><span>Payment mode</span><select id="ep-mode">${options.map(m => `<option ${m === curMode ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
        <label><span>Payment reference</span><input type="text" id="ep-ref" value="${esc(p.cash_reference || '')}"></label>
        <label><span>Notes</span><textarea id="ep-notes" rows="2">${esc(p.manual_notes || '')}</textarea></label>
      </div>`, 'Save', () => submitEditPayment(id, onDone));
  }).catch(e => toast(errText(e, 'Could not load that payment'), 'warning'));
}
function submitEditPayment(id, onDone) {
  const body = {
    date: document.getElementById('ep-date').value || null,
    mode: document.getElementById('ep-mode').value,
    reference: document.getElementById('ep-ref').value.trim() || null,
    notes: document.getElementById('ep-notes').value.trim() || null,
  };
  api(`/api/finance/payments/${id}`, { method: 'PUT', body }).then(() => {
    closeModal(); toast('Payment updated', 'success'); onDone();
  }).catch(e => toast(errText(e), 'warning'));
}

// ── Add payment ────────────────────────────────────────────────────────────
function openAddPaymentModal(opts = {}) {
  const modeOptions = ['Bank transfer', 'Tax-Free Childcare', 'Card', 'Cash', 'Childcare vouchers', 'Direct Debit', 'Deposit'];
  const today = new Date().toISOString().slice(0, 10);
  Wren.modal('Add payment', `
    <div class="mny-form">
      <label><span>Child</span><div id="ap-child-mount"></div></label>
      <label><span>Date of payment</span><input type="date" id="ap-date" value="${today}"></label>
      <label><span>Payment mode</span><select id="ap-mode">${modeOptions.map(m => `<option ${m === 'Bank transfer' ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label><span>Amount paid (£)</span><input type="number" id="ap-amount" step="0.01" min="0.01" value="${opts.prefillAmountPence ? (opts.prefillAmountPence/100).toFixed(2) : ''}"></label>
      <label><span>Payment reference</span><input type="text" id="ap-ref" placeholder="optional"></label>
      <label><span>Notes</span><textarea id="ap-notes" rows="2"></textarea></label>
      <div>
        <span style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--c-muted);display:block;margin-bottom:4px">Apply to</span>
        <div class="mny-radio-row">
          ${opts.wholeBalance ? '<label><input type="radio" name="ap-apply" value="balance" checked> Whole family balance, oldest first</label>' : ''}
          <label><input type="radio" name="ap-apply" value="oldest"${opts.wholeBalance ? '' : ' checked'}> Oldest unpaid first</label>
          <label><input type="radio" name="ap-apply" value="invoice"> A chosen invoice</label>
          <label><input type="radio" name="ap-apply" value="account"> On account (credit)</label>
        </div>
        <select id="ap-invoice" style="margin-top:6px;display:none"></select>
      </div>
    </div>`, [
    { label: 'Cancel' },
    { label: 'Add payment', class: 'btn-primary', close: false, action: () => submitAddPayment(opts) },
  ]);
  const mount = document.getElementById('ap-child-mount');
  const invoiceSel = document.getElementById('ap-invoice');
  let pickedChildId = opts.childId || null;
  const loadInvoicesFor = (childId) => {
    if (!childId) { invoiceSel.innerHTML = ''; return; }
    api('/api/finance/invoices/?child_id=' + childId + '&limit=50').then(d => {
      const open = (d.invoices || []).filter(i => ['sent', 'overdue'].includes(i.status) && (i.balance_pence || 0) > 0);
      invoiceSel.innerHTML = open.length
        ? open.map(i => `<option value="${i.id}">${esc(i.invoice_number || '#' + i.id)} — ${fmt(i.balance_pence)} owing</option>`).join('')
        : '<option value="">No open invoices for this child</option>';
    }).catch(() => {});
  };
  mountChildPicker(mount, (c) => { pickedChildId = c.id; loadInvoicesFor(c.id); }, 'Search a child…');
  if (opts.childId) {
    mount.querySelector('.mny-child-input').value = opts.childName || '';
    mount.querySelector('.mny-child-id').value = opts.childId;
  }
  mount._pickedChildId = () => pickedChildId;
  document.querySelectorAll('input[name="ap-apply"]').forEach(r => r.addEventListener('change', () => {
    const v = document.querySelector('input[name="ap-apply"]:checked').value;
    invoiceSel.style.display = v === 'invoice' ? 'block' : 'none';
    if (v === 'invoice' && pickedChildId) loadInvoicesFor(pickedChildId);
  }));
  if (opts.applyTo === 'invoice') {
    document.querySelector('input[name="ap-apply"][value="invoice"]').checked = true;
    invoiceSel.style.display = 'block';
    loadInvoicesFor(opts.childId);
    if (opts.invoiceId) setTimeout(() => { invoiceSel.value = String(opts.invoiceId); }, 300);
  }
}
function submitAddPayment(opts) {
  const mount = document.getElementById('ap-child-mount');
  const childId = mount._pickedChildId ? mount._pickedChildId() : null;
  const amount = parseFloat(document.getElementById('ap-amount').value || '0');
  const applyTo = document.querySelector('input[name="ap-apply"]:checked').value;
  const invoiceId = applyTo === 'invoice' ? parseInt(document.getElementById('ap-invoice').value || '0', 10) : null;
  if (!childId) { toast('Pick a child first', 'warning'); return; }
  if (!(amount > 0)) { toast('Enter an amount greater than £0', 'warning'); return; }
  if (applyTo === 'invoice' && !invoiceId) { toast('Pick an invoice to apply this to', 'warning'); return; }
  const body = {
    child_id: childId,
    date: document.getElementById('ap-date').value,
    mode: document.getElementById('ap-mode').value,
    amount_pence: Math.round(amount * 100),
    reference: document.getElementById('ap-ref').value.trim() || null,
    notes: document.getElementById('ap-notes').value.trim() || null,
    apply_to: applyTo,
    invoice_id: invoiceId,
  };
  api('/api/finance/payments/manual', { method: 'POST', body }).then(d => {
    closeModal();
    const bits = [];
    if (d.allocated_pence) bits.push(`${fmt(d.allocated_pence)} allocated`);
    if (d.credit_pence) bits.push(`${fmt(d.credit_pence)} on account`);
    toast('Payment recorded' + (bits.length ? ' — ' + bits.join(', ') : ''), 'success');
    loadPayments(); loadInvoices();
    if (typeof opts.onDone === 'function') opts.onDone();
  }).catch(e => toast(errText(e, 'Could not record that payment'), 'warning'));
}

// ── Add credit note ─────────────────────────────────────────────────────────
function openCreditNoteModal(opts = {}) {
  Wren.modal('Add credit note', `
    <div class="mny-form">
      <label><span>Child</span><div id="cn-child-mount"></div></label>
      <label><span>Against invoice (optional)</span><select id="cn-invoice"><option value="">Not against a specific invoice — goes on account</option></select></label>
      <label><span>Amount (£)</span><input type="number" id="cn-amount" step="0.01" min="0.01"></label>
      <label><span>Reason</span><textarea id="cn-reason" rows="2"></textarea></label>
    </div>`, [
    { label: 'Cancel' },
    { label: 'Add credit note', class: 'btn-primary', close: false, action: () => submitCreditNote(opts) },
  ]);
  const mount = document.getElementById('cn-child-mount');
  const invoiceSel = document.getElementById('cn-invoice');
  let pickedChildId = opts.childId || null;
  const loadInvoicesFor = (childId) => {
    if (!childId) return;
    api('/api/finance/invoices/?child_id=' + childId + '&limit=50').then(d => {
      const list = (d.invoices || []).filter(i => i.status !== 'draft' && i.status !== 'credit_note');
      invoiceSel.innerHTML = '<option value="">Not against a specific invoice — goes on account</option>' +
        list.map(i => `<option value="${i.id}">${esc(i.invoice_number || '#' + i.id)} — ${fmt(i.amount_pence)}</option>`).join('');
    }).catch(() => {});
  };
  mountChildPicker(mount, (c) => { pickedChildId = c.id; loadInvoicesFor(c.id); }, 'Search a child…');
  if (opts.childId) {
    mount.querySelector('.mny-child-input').value = opts.childName || '';
    mount.querySelector('.mny-child-id').value = opts.childId;
    loadInvoicesFor(opts.childId);
  }
  mount._pickedChildId = () => pickedChildId;
  if (opts.invoiceId) setTimeout(() => { invoiceSel.value = String(opts.invoiceId); }, 300);
}
function submitCreditNote(opts) {
  const mount = document.getElementById('cn-child-mount');
  const childId = mount._pickedChildId ? mount._pickedChildId() : null;
  const amount = parseFloat(document.getElementById('cn-amount').value || '0');
  const invoiceId = parseInt(document.getElementById('cn-invoice').value || '0', 10) || null;
  if (!childId && !invoiceId) { toast('Pick a child or an invoice', 'warning'); return; }
  if (!(amount > 0)) { toast('Enter an amount greater than £0', 'warning'); return; }
  api('/api/finance/payments/credit-note', { method: 'POST', body: {
    child_id: childId, invoice_id: invoiceId, amount_pence: Math.round(amount * 100),
    reason: document.getElementById('cn-reason').value.trim() || null,
  } }).then(() => {
    closeModal(); toast('Credit note added', 'success'); loadInvoices(); loadPayments();
    if (typeof opts.onDone === 'function') opts.onDone();
  }).catch(e => toast(errText(e, 'Could not add that credit note'), 'warning'));
}

function initPayments() {
  document.getElementById('btn-pay-search').addEventListener('click', loadPayments);
  document.getElementById('pay-f-q').addEventListener('keydown', e => { if (e.key === 'Enter') loadPayments(); });
  document.getElementById('btn-pay-add').addEventListener('click', () => openAddPaymentModal({}));
  document.getElementById('btn-pay-credit').addEventListener('click', () => openCreditNoteModal({}));
  loadPayments();
}

// ══════════════════════════════════════════════════════════════════════════
// RECONCILE — the unmatched queue only; the deeper tools stay on Finance (full).
// 2026-10-08: links went to /finance.html/reconcile/reconcile, which isn't a Roost route
// (routes are /admin/<section>/<tab>) — Match… dropped Toby on the home screen.
// ══════════════════════════════════════════════════════════════════════════
function loadReconcile() {
  const tbody = document.getElementById('rec-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="mny-empty">Loading…</td></tr>';
  api('/api/finance/reconcile/unmatched-lines').then(d => {
    const lines = d.lines || [];
    const s = d.summary || {};
    document.getElementById('rec-summary').textContent =
      `${s.total_matching != null ? s.total_matching : lines.length} unmatched line(s)` +
      (s.total_pence ? ` · ${fmt(s.total_pence)}` : '') +
      (s.with_suggestion != null ? ` · ${s.with_suggestion} with a suggested match` : '');
    if (!lines.length) { tbody.innerHTML = '<tr><td colspan="5" class="mny-empty">Nothing waiting to be reconciled.</td></tr>'; return; }
    tbody.innerHTML = lines.map(l => `<tr>
      <td>${ymdPretty(String(l.transaction_date).slice(0, 10))}</td>
      <td>${esc(l.description || l.payee_name || '')}</td>
      <td class="num">${fmt(l.amount_pence)}</td>
      <td>${l.match_id ? esc(l.child_name || '—') + ' · ' + esc(l.invoice_number || '') + ` (${l.confidence_score}%)` : '<span class="mny-muted">no suggestion</span>'}</td>
      <td>${l.match_id
        ? `<button class="mny-btn" data-confirm="${l.match_id}">Confirm</button> <button class="mny-btn" data-reject="${l.match_id}">Reject</button>`
        : `<a class="mny-btn" href="/admin/finance/reconcile?match_line=${encodeURIComponent(l.line_id)}">Match…</a>`}</td>
    </tr>`).join('');
    tbody.querySelectorAll('[data-confirm]').forEach(b => b.addEventListener('click', () => {
      api(`/api/finance/reconcile/matches/${b.dataset.confirm}/confirm`, { method: 'POST' })
        .then(() => { toast('Confirmed', 'success'); loadReconcile(); }).catch(e => toast(errText(e), 'warning'));
    }));
    tbody.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => {
      api(`/api/finance/reconcile/matches/${b.dataset.reject}/reject`, { method: 'POST', body: { reason: 'Rejected from Invoices & Payments' } })
        .then(() => { toast('Rejected', 'success'); loadReconcile(); }).catch(e => toast(errText(e), 'warning'));
    }));
  }).catch(e => { tbody.innerHTML = `<tr><td colspan="5" class="mny-empty">${esc(errText(e, 'Could not load the queue'))}</td></tr>`; });
}
function initReconcile() {
  document.getElementById('btn-rec-refresh').addEventListener('click', loadReconcile);
  loadReconcile();
}

// ══════════════════════════════════════════════════════════════════════════
// FUNDING — read-only summary; full editing stays on /funding.html
// ══════════════════════════════════════════════════════════════════════════
function loadFunding() {
  api('/api/funding/terms/current').then(term => {
    if (!term || !term.id) {
      document.getElementById('fund-term-title').textContent = 'Funding — no current term set';
      return;
    }
    document.getElementById('fund-term-title').textContent = `Funding — ${term.name || term.label || ('Term #' + term.id)}`;
    Promise.all([
      api(`/api/funding/terms/${term.id}/summary`),
      api(`/api/funding/terms/${term.id}/children`),
    ]).then(([summary, children]) => {
      const t = summary.totals || {};
      document.getElementById('fund-stats').innerHTML = [
        ['Funded children', t.total_children || 0],
        ['Total hours/term', Number(t.total_hours || 0).toFixed(1)],
        ['Estimated value', fmt(Math.round((Number(t.total_value) || 0) * 100))],
        ['Declarations outstanding', t.declarations_outstanding || 0],
      ].map(([l, n]) => `<div class="mny-stat"><div class="n">${esc(String(n))}</div><div class="l">${esc(l)}</div></div>`).join('');
      const all = Array.isArray(children) ? children : (children.children || []);
      const rows = all.filter(c => c.funding_type && c.funding_type !== 'none');
      const tbody = document.getElementById('fund-tbody');
      tbody.innerHTML = rows.length ? rows.map(c => `<tr>
        <td>${esc(c.first_name || '')} ${esc(c.last_name || '')}</td><td>${esc(c.room_name || c.room || '—')}</td>
        <td class="num">${c.universal_hours_week != null ? c.universal_hours_week : '—'}</td>
        <td class="num">${c.extended_hours_week != null ? c.extended_hours_week : '—'}</td>
        <td class="num">${c.two_year_hours_week != null ? c.two_year_hours_week : (c.funding_type && c.funding_type.includes('2yr') ? (c.total_hours_week ?? '—') : '—')}</td>
        <td class="mny-muted">${esc(c.thirty_hour_code || '—')}</td>
        <td>${c.declaration_signed ? '✓' : '—'}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="mny-empty">No funded children this term.</td></tr>';
    }).catch(e => toast(errText(e, 'Could not load the funding summary'), 'warning'));
  }).catch(e => toast(errText(e, 'Could not load the current funding term'), 'warning'));
}
function initFunding() { loadFunding(); }

// ══════════════════════════════════════════════════════════════════════════
// FAMILIES — the ledger, EyMan's per-child Transactions/Payments tab
// ══════════════════════════════════════════════════════════════════════════
let FAM_CHILD_IDS = [];
let FAM_LEDGER = null;

function searchFamilies() {
  const q = document.getElementById('fam-search').value.trim();
  const box = document.getElementById('fam-results');
  if (q.length < 2) { box.innerHTML = ''; return; }
  api('/api/children/search?q=' + encodeURIComponent(q) + '&limit=12').then(d => {
    const rows = d.results || [];
    box.innerHTML = rows.length ? rows.map(c => `<div class="mny-fam-card" data-id="${c.id}" data-name="${esc(c.first_name + ' ' + c.last_name)}">
      <span>${esc(c.first_name)} ${esc(c.last_name)} <span class="mny-muted">· ${esc(c.room_name || '')}</span></span>
      <span class="mny-muted">Open statement →</span></div>`).join('') : '<p class="mny-muted">No match.</p>';
    box.querySelectorAll('.mny-fam-card').forEach(card => card.addEventListener('click', () =>
      openFamily(parseInt(card.dataset.id, 10), card.dataset.name)));
  }).catch(() => {});
}

function openFamily(childId, childName) {
  document.getElementById('fam-statement').hidden = false;
  document.getElementById('fam-title').textContent = childName ? `${childName}'s family` : 'Family';
  api('/api/payments-admin/ledger?child_id=' + childId).then(d => {
    FAM_LEDGER = d;
    FAM_CHILD_IDS = d.child_ids || [childId];
    const bal = d.balance_pence || 0;
    const balEl = document.getElementById('fam-balance');
    balEl.className = 'mny-balance ' + (bal > 0 ? 'owed' : bal < 0 ? 'credit' : '');
    balEl.textContent = bal === 0 ? 'Balance: £0.00' : (bal > 0 ? `Owes ${fmt(bal)}` : `In credit ${fmt(-bal)}`);
    if (d.deposit_pence) balEl.textContent += ` · ${fmt(d.deposit_pence)} deposit held`;
    renderFamilyTransactions(d.transactions || []);
    document.getElementById('btn-fam-pay').onclick = () => openAddPaymentModal({ childId, childName, onDone: () => openFamily(childId, childName) });
    // b492 (2026-10-12, DEV ONLY) — "Record one payment for the whole balance": the same
    // Add payment modal, "Oldest unpaid first" already the default, just pre-filled with
    // exactly what is owed. Manager/finance only — accountant tokens never reach the write
    // route this submits to (src/routes/finance-payments.js' managerGuard + the accountant
    // scope gate in server-unified.js, which blocks every non-GET for that role outright).
    const payBalanceBtn = document.getElementById('btn-fam-pay-balance');
    payBalanceBtn.hidden = !(bal > 0);
    payBalanceBtn.onclick = () => openAddPaymentModal({
      childId, childName, prefillAmountPence: bal, wholeBalance: true, onDone: () => openFamily(childId, childName),
    });
    document.getElementById('btn-fam-credit').onclick = () => openCreditNoteModal({ childId, childName, onDone: () => openFamily(childId, childName) });
    // b423 (2026-10-08) — acts on THIS child's own opening-balance row, never a sibling's.
    const mine = (d.opening || []).find(o => Number(o.child_id) === Number(childId)) || null;
    const obBtn = document.getElementById('btn-fam-ob');
    obBtn.hidden = false;
    obBtn.textContent = mine ? `Opening balance: ${obSigned(Number(mine.balance_pence))}…` : 'Add opening balance…';
    obBtn.onclick = () => openOpeningBalanceModal({ childId, childName, onDone: () => openFamily(childId, childName) });
    loadFamilySubTabs(childId);
  }).catch(e => toast(errText(e, 'Could not load this family’s statement'), 'warning'));
}
function renderFamilyTransactions(tx) {
  const tbody = document.getElementById('fam-txn-tbody');
  tbody.innerHTML = tx.length ? tx.map(t => `<tr>
    <td class="mny-muted">${esc(t.txn_no || '')}</td><td>${ymdPretty(String(t.on_date).slice(0, 10))}</td>
    <td>${esc(t.type)}</td><td class="mny-muted">${esc(t.mode || '—')}</td><td class="mny-muted">${esc(t.reference || '—')}</td>
    <td class="num">${fmt(t.amount_pence)}</td><td class="num">${fmt(t.balance_pence)}</td>
  </tr>`).join('') : '<tr><td colspan="7" class="mny-empty">No transactions yet.</td></tr>';
}
function loadFamilySubTabs(childId) {
  // Invoices / Payments sub-tabs reuse the same list endpoints, scoped to this child.
  Promise.all([
    api('/api/finance/invoices/?child_id=' + childId + '&limit=100'),
    api('/api/finance/payments?child_ids=' + FAM_CHILD_IDS.join(',') + '&limit=100'),
  ]).then(([invD, payD]) => {
    document.getElementById('fampanel-inv').innerHTML = renderMiniTable(
      ['Invoice', 'Period', 'Amount', 'Balance', 'Status'],
      (invD.invoices || []).map(i => [esc(i.invoice_number || '#' + i.id), esc(i.period_label || ''),
        fmt(i.amount_pence), fmt(i.balance_pence), esc(i.status)]));
    const pays = payD.payments || [];
    document.getElementById('fampanel-pay').innerHTML = renderMiniTable(
      ['Payment no.', 'Date', 'Mode', 'Amount'],
      pays.map(p => [esc(p.payment_no), ymdPretty(String(p.paid_on || p.created_at).slice(0, 10)), esc(p.payment_method || ''), fmt(p.amount_pence)]));
  }).catch(() => {});
  api('/api/children/' + childId).then(c => {
    document.getElementById('fampanel-acct').innerHTML = `
      <div class="mny-form" style="max-width:420px">
        <label><span>Bill payer email</span><input value="${esc(c.primary_contact_email || '')}" readonly></label>
        <label><span>TFC reference</span><input value="${esc(c.tfc_payment_reference || '')}" readonly></label>
        <p class="mny-hint">Editable on the child's profile — this is a read-only summary.</p>
      </div>`;
  }).catch(() => { document.getElementById('fampanel-acct').innerHTML = '<p class="mny-muted">Could not load account details.</p>'; });
  document.getElementById('fampanel-fund').innerHTML = '<p class="mny-muted">See the Funding tab for this child’s current-term allocation.</p>';
}
function renderMiniTable(headers, rows) {
  if (!rows.length) return '<p class="mny-empty">None.</p>';
  return `<table class="mny-table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
// ══════════════════════════════════════════════════════════════════════════
// OPENING BALANCE (b423, 2026-10-08, DEV ONLY) — edit or add the EyLog opening
// balance for a child. The money rule lives in src/lib/opening-balance.js; this is
// just the form. The preview below is a real server round trip (a rolled-back
// transaction), because b423c (2026-10-11) means some edits now REFUSE (real money
// settled on the bill) rather than silently moving it — arithmetic alone can't know that.
// ══════════════════════════════════════════════════════════════════════════
function obSigned(p) {
  p = Number(p) || 0;
  return p === 0 ? '£0.00' : (p > 0 ? fmt(p) + ' owed' : fmt(-p) + ' in credit');
}
function openOpeningBalanceModal(opts = {}) {
  const { childId, childName, onDone } = opts;
  api('/api/finance/opening-balance/' + childId).then(data => {
    const ob = data.opening_balance;
    const curPence = ob ? Number(ob.balance_pence) : 0;
    const isAdd = !ob;
    const curSign = curPence < 0 ? 'credit' : 'owed';
    let obOverride = false; // set once the user ticks through a needs_override warning
    formModal(
      (isAdd ? 'Add opening balance' : 'Edit opening balance') + (childName ? ' — ' + esc(childName) : ''),
      `<div class="mny-form">
        <p class="mny-hint">${isAdd
          ? 'This child has no EyLog opening balance recorded.'
          : `Currently ${esc(obSigned(curPence))}${ob.as_of ? ' as of ' + ymdPretty(String(ob.as_of).slice(0, 10)) : ''}.`}</p>
        <label><span>Amount (£)</span><input type="number" id="ob-amount" step="0.01" min="0"
          value="${curPence !== 0 ? (Math.abs(curPence) / 100).toFixed(2) : ''}"></label>
        <div>
          <span style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--c-muted);display:block;margin-bottom:4px">This is</span>
          <div class="mny-radio-row">
            <label><input type="radio" name="ob-sign" value="owed" ${curSign !== 'credit' ? 'checked' : ''}> Owed</label>
            <label><input type="radio" name="ob-sign" value="credit" ${curSign === 'credit' ? 'checked' : ''}> In credit</label>
          </div>
        </div>
        <label><span>Reason</span><textarea id="ob-reason" rows="2" placeholder="Why is this changing — e.g. EyLog's own statement said a different figure"></textarea></label>
        <div id="ob-preview" class="mny-hint" style="margin-top:2px"></div>
      </div>`, isAdd ? 'Add' : 'Save',
      () => submitOpeningBalance({ childId, curPence, onDone, getOverride: () => obOverride }));
    // b423b (2026-10-11) — the preview is the family's real ledger balance before/after,
    // computed server-side in a rolled-back transaction (src/lib/opening-balance.js
    // preview mode) — never arithmetic on the opening-balance figure alone, which could
    // be miles off the true total (e.g. other pre-cutover activity, credit notes).
    let obPreviewTimer = null;
    let obPreviewSeq = 0; // b423c — a stale in-flight response must never clobber a newer one
    const recalc = () => {
      const amt = Math.round(parseFloat(document.getElementById('ob-amount').value || '0') * 100);
      const signVal = document.querySelector('input[name="ob-sign"]:checked').value;
      const newPence = signVal === 'credit' ? -amt : amt;
      const previewEl = document.getElementById('ob-preview');
      const mySeq = ++obPreviewSeq;
      if (newPence === curPence) { previewEl.textContent = 'No change.'; return; }
      previewEl.textContent = 'Calculating…';
      clearTimeout(obPreviewTimer);
      obPreviewTimer = setTimeout(() => {
        api(`/api/finance/opening-balance/${childId}`, { method: 'PUT', body: { balance_pence: newPence, preview: true, override: obOverride } })
          .then(r => {
            if (mySeq !== obPreviewSeq) return; // a later keystroke/toggle already moved on
            const b0 = r.before_family_balance_pence, b1 = r.after_family_balance_pence;
            previewEl.textContent = `The family's balance moves from ${obSigned(b0)} to ${obSigned(b1)}` +
              (b1 !== b0 ? ` (${b1 > b0 ? '+' : '-'}${fmt(Math.abs(b1 - b0))})` : '') + '.';
          })
          .catch(e => {
            if (mySeq !== obPreviewSeq) return;
            if (e && e.code === 'needs_override' && e.can_override) {
              previewEl.innerHTML = `${esc(e.error)} <button type="button" id="ob-override-btn" class="mny-btn" style="font-size:.7rem;padding:2px 8px;margin-left:4px">I understand</button>`;
              const btn = document.getElementById('ob-override-btn');
              if (btn) btn.onclick = () => { obOverride = true; recalc(); };
            } else if (e && e.code === 'locked_funds') {
              // b423c — a hard refusal, never overridable from here: real money is
              // sitting on this bill and must be sorted in Reconcile first.
              previewEl.textContent = e.error || 'This balance has real payments on it — see Reconcile.';
            } else {
              previewEl.textContent = '';
            }
          });
      }, 300);
    };
    document.getElementById('ob-amount').addEventListener('input', recalc);
    document.querySelectorAll('input[name="ob-sign"]').forEach(r => r.addEventListener('change', recalc));
    recalc();
  }).catch(e => toast(errText(e, 'Could not load the opening balance'), 'warning'));
}
function submitOpeningBalance({ childId, curPence, onDone, getOverride }) {
  const amt = Math.round(parseFloat(document.getElementById('ob-amount').value || '0') * 100);
  const signVal = document.querySelector('input[name="ob-sign"]:checked').value;
  const newPence = signVal === 'credit' ? -amt : amt;
  const reason = document.getElementById('ob-reason').value.trim();
  if (!reason) { toast('A reason is required', 'warning'); return; }
  if (newPence === curPence) { toast('That is already the current figure', 'warning'); return; }
  api(`/api/finance/opening-balance/${childId}`, { method: 'PUT', body: { balance_pence: newPence, reason, override: !!(getOverride && getOverride()) } })
    .then(() => {
      closeModal();
      toast('Opening balance updated', 'success');
      if (typeof onDone === 'function') onDone();
    }).catch(e => {
      if (e && e.code === 'needs_override' && e.can_override && confirm(e.error + '\n\nProceed anyway?')) {
        api(`/api/finance/opening-balance/${childId}`, { method: 'PUT', body: { balance_pence: newPence, reason, override: true } })
          .then(() => { closeModal(); toast('Opening balance updated', 'success'); if (typeof onDone === 'function') onDone(); })
          .catch(e2 => toast(errText(e2, 'Could not save that'), 'warning'));
        return;
      }
      toast(errText(e, 'Could not save that'), 'warning');
    });
}
function openOpeningBalanceHistory(childId) {
  api('/api/finance/opening-balance/' + childId).then(data => {
    const rows = data.history || [];
    Wren.modal('Opening balance — change history', rows.length
      ? `<table class="mny-alloc-table"><thead><tr><th>Date</th><th class="num">From</th><th class="num">To</th><th>Reason</th><th>By</th></tr></thead>
         <tbody>${rows.map(h => `<tr><td style="white-space:nowrap">${ymdPretty(String(h.changed_at).slice(0, 10))}</td>
           <td class="num">${esc(obSigned(h.old_pence))}</td><td class="num">${esc(obSigned(h.new_pence))}</td>
           <td>${esc(h.reason || '—')}</td><td class="mny-muted">${esc(h.changed_by || '—')}</td></tr>`).join('')}</tbody></table>`
      : '<p class="mny-muted">No changes recorded yet.</p>', [{ label: 'Close' }]);
  }).catch(e => toast(errText(e, 'Could not load that history'), 'warning'));
}

function initFamilies() {
  document.getElementById('btn-fam-search').addEventListener('click', searchFamilies);
  document.getElementById('fam-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchFamilies(); });
  document.getElementById('btn-fam-close').addEventListener('click', () => { document.getElementById('fam-statement').hidden = true; });
  document.querySelectorAll('[data-famtab]').forEach(btn => {
    if (btn.tagName !== 'BUTTON') return;
    btn.addEventListener('click', () => {
      const name = btn.dataset.famtab;
      document.querySelectorAll('[data-famtab]').forEach(el => {
        if (el.tagName === 'BUTTON') { el.classList.toggle('wren-tab-active', el === btn); }
        else { el.hidden = el.dataset.famtab !== name; }
      });
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Generate ONE child's invoice for a month (b401) — the child profile's "New invoice"
// button. Distinct from openGenerateModal()/runGenerate() above, which generate for every
// child in the nursery through generate-itemised; this is POST /api/finance/invoices/generate
// with child_ids:[id], the same route, scoped to one child, so it can preview then create.
// ══════════════════════════════════════════════════════════════════════════
function openGenerateInvoiceModal(opts = {}) {
  const now = new Date();
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  Wren.modal(`New invoice${opts.childName ? ' — ' + esc(opts.childName) : ''}`, `
    <div class="mny-form">
      <label><span>Year</span><select id="cgi-year">${years.map(y => `<option value="${y}" ${y === now.getFullYear() ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <label><span>Month</span><select id="cgi-month">${MONTH_NAMES.slice(1).map((m, i) => `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <p class="mny-hint">Preview first — nothing is created until you confirm.</p>
      <div id="cgi-preview"></div>
    </div>`, [
    { label: 'Close' },
    // b401 — Wren.modal() closes on any click unless close:false (see wren-shell-v2.js
    // modal()); without it this button closed the modal before the preview could render.
    // The bulk "Generate invoices for a month…" modal above has the same latent bug —
    // flagged for Toby, not fixed here (out of scope for this build).
    { label: 'Preview', close: false, action: () => runGenerateForChild(opts, true) },
  ]);
}
function runGenerateForChild(opts, preview) {
  const year = parseInt(document.getElementById('cgi-year').value, 10);
  const month = parseInt(document.getElementById('cgi-month').value, 10);
  const box = document.getElementById('cgi-preview');
  box.innerHTML = '<p class="mny-muted">Working…</p>';
  api('/api/finance/invoices/generate', { method: 'POST', body: { year, month, child_ids: [opts.childId], preview } })
    .then(d => {
      const row = (d.invoices || [])[0];
      if (!row) {
        box.innerHTML = `<p class="mny-muted">Nothing to invoice — this child is not billable for ${MONTH_NAMES[month]} ${year} (left, not started, or already has one).</p>`;
        return;
      }
      if (preview) {
        box.innerHTML = `<p>Would charge <b>${fmt(row.amount_pence)}</b> for ${esc(MONTH_NAMES[month])} ${year}.
          ${row.already_invoiced ? '<br><span style="color:var(--c-warn)">An invoice already exists for this month — creating again is skipped.</span>' : ''}</p>
          ${!row.already_invoiced ? `<button class="mny-btn mny-btn-primary" id="cgi-confirm" type="button">Create this invoice</button>` : ''}`;
        const confirmBtn = document.getElementById('cgi-confirm');
        if (confirmBtn) confirmBtn.addEventListener('click', () => runGenerateForChild(opts, false));
      } else {
        box.innerHTML = `<p>${pill('Done', 'ok')} ${esc(row.invoice_number || 'Invoice')} created for ${fmt(row.amount_pence)}.</p>`;
        toast('Invoice created', 'success');
        if (typeof opts.onDone === 'function') opts.onDone();
      }
    })
    .catch(e => { box.innerHTML = `<p style="color:var(--c-danger)">${esc(errText(e, 'Could not generate'))}</p>`; });
}

// ── A plain CSV statement, client-side (b401) — "so that in future if I ever need to look
// back", the way EyMan's own Transactions export worked. Not a PDF: that would need its own
// layout and a new money rule to lay out, which is a bigger job than this button earns. ────
function downloadLedgerCsv(ledger, label) {
  const rows = [['Txn no.', 'Date', 'Type', 'Mode', 'Reference', 'Amount', 'Balance']];
  [...(ledger.history || []), ...(ledger.transactions || [])].forEach(t => rows.push([
    t.txn_no || '', t.on_date || '', t.type || '', t.mode || '', t.reference || '',
    ((t.amount_pence || 0) / 100).toFixed(2), ((t.balance_pence || 0) / 100).toFixed(2),
  ]));
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `statement-${String(label || 'family').replace(/[^a-z0-9]+/gi, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ══════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// WHO OWES + INCOME FORECAST (2026-10-09)
// ══════════════════════════════════════════════════════════════════════════
function _famLink(f) { return `<button class="mny-btn" data-owes-open="${f.child_ids[0]}" data-owes-name="${esc(f.label)}">Statement</button>`; }
function _d(s) { return s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function initOwes() {
  const tb = document.getElementById('owes-rows'); tb.innerHTML = '<tr><td colspan="7" class="mny-muted">Loading…</td></tr>';
  api('/api/finance/payments/outstanding').then(d => {
    const t = d.totals || {};
    document.getElementById('owes-totals').innerHTML =
      `<span class="mny-pill bad" style="font-size:.86rem;padding:7px 14px">${t.families_owing || 0} families owe ${fmt(t.owing_pence)}</span>` +
      `<span class="mny-pill ok" style="font-size:.86rem;padding:7px 14px">${t.families_in_credit || 0} in credit ${fmt(t.in_credit_pence)}</span>` +
      `<span class="mny-muted">The family balance — the same figure parents see in the app. Click Statement for the detail.</span>`;
    tb.innerHTML = (d.owing || []).length ? d.owing.map(f => `<tr>
      <td><b>${esc(f.label)}</b>${f.active ? '' : ' <span class="mny-muted">(left)</span>'}</td>
      <td class="num"><b style="color:var(--c-danger)">${fmt(f.balance_pence)}</b></td>
      <td>${(f.bills || []).map(b => `${esc(b.period || b.number)} <span class="mny-muted">${fmt(b.left_pence)}</span>`).join('<br>') || '<span class="mny-muted">—</span>'}</td>
      <td>${_d(f.oldest_due)}</td>
      <td class="num">${f.days_overdue ? f.days_overdue : '—'}</td>
      <td>${f.last_payment ? `${_d(f.last_payment.on)} <span class="mny-muted">${fmt(f.last_payment.pence)}</span>` : '<span class="mny-muted">none since the move to Wren</span>'}</td>
      <td>${_famLink(f)}</td></tr>`).join('') : '<tr><td colspan="7" class="mny-muted">Nobody owes anything. 🎉</td></tr>';
    document.getElementById('owes-credit-sum').textContent = `Families in credit (${(d.in_credit || []).length})`;
    document.getElementById('owes-credit-rows').innerHTML = (d.in_credit || []).map(f => `<tr>
      <td>${esc(f.label)}</td><td class="num"><b style="color:var(--c-ok)">${fmt(-f.balance_pence)}</b></td>
      <td>${f.last_payment ? `${_d(f.last_payment.on)} <span class="mny-muted">${fmt(f.last_payment.pence)}</span>` : '—'}</td><td>${_famLink(f)}</td></tr>`).join('');
  }).catch(e => { tb.innerHTML = `<tr><td colspan="7" class="mny-muted">Could not load: ${esc(e.error || e.message || '')}</td></tr>`; });
  // Accountant data pack (2026-10-09): a file download, so fetch with the token and save the blob.
  const toEl = document.getElementById('pack-to'); if (toEl && !toEl.value) toEl.value = new Date().toISOString().slice(0, 10);
  const go = document.getElementById('pack-go');
  if (go) go.addEventListener('click', async () => {
    const q = new URLSearchParams({ from: document.getElementById('pack-from').value, to: document.getElementById('pack-to').value,
                                    names: document.getElementById('pack-names').checked ? '1' : '0' });
    const label = go.textContent; go.disabled = true; go.textContent = 'Preparing…';
    try {
      const headers = { Authorization: 'Bearer ' + sessionStorage.getItem('wrenToken') };
      try { const dv = localStorage.getItem('wrenDevice'); if (dv) headers['X-Wren-Device'] = dv; } catch (_) {}
      const r = await fetch('/api/finance/payments/accountant-pack?' + q, { headers });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + r.status)); }
      const blob = await r.blob(); const m = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = m ? m[1] : 'wren-accountant-pack.xlsx'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast('Could not prepare the pack: ' + (e.message || ''), 'warning'); }
    finally { go.disabled = false; go.textContent = label; }
  });
  document.getElementById('mny-panel-owes').addEventListener('click', e => {
    const b = e.target.closest('[data-owes-open]'); if (!b) return;
    showMainTab('families'); openFamily(b.dataset.owesOpen, b.dataset.owesName);
  });
}
let FC = null;
function initForecast() {
  const now = new Date(); const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('fc-from').value = ym(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  document.getElementById('fc-to').value = ym(new Date(now.getFullYear(), now.getMonth() + 6, 1));
  document.getElementById('fc-go').onclick = loadForecast;
  document.getElementById('fc-view').onchange = () => FC && renderForecast();
  document.getElementById('fc-csv').onclick = forecastCsv;
  loadForecast();
}
function loadForecast() {
  const q = new URLSearchParams({ from: document.getElementById('fc-from').value, to: document.getElementById('fc-to').value, by: document.getElementById('fc-by').value });
  document.getElementById('fc-table').innerHTML = '<tbody><tr><td class="mny-muted">Working it out from the monthly invoice run… (a few seconds a month)</td></tr></tbody>';
  api('/api/finance/payments/income-forecast?' + q).then(d => { FC = d; renderForecast(); })
    .catch(e => { document.getElementById('fc-table').innerHTML = `<tbody><tr><td class="mny-muted">Could not load: ${esc(e.error || e.message || '')}</td></tr></tbody>`; });
}
function _fcCell(v, view) { if (!v) return 0; return view === 'income' ? v.income : view === 'funding' ? v.funding : v.income + v.funding; }
function _mLabel(mk) { const [y, m] = mk.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }); }
function renderForecast() {
  const d = FC; const view = document.getElementById('fc-view').value;
  const what = view === 'income' ? 'what parents pay' : view === 'funding' ? 'council funding' : 'total income (parents + funding)';
  document.getElementById('fc-note').textContent = `${what} · ${d.source}`;
  const rows = d.rows.map(r => ({ ...r, total: d.months.reduce((t, mk) => t + _fcCell(r.months[mk], view), 0) }))
    .filter(r => r.total !== 0).sort((a, b) => b.total - a.total);
  const both = view === 'both';
  const head = `<thead><tr><th>${esc({ children: 'Child', rooms: 'Room', products: 'Session / product', categories: 'Category' }[d.by])}</th>${
    d.months.map(mk => `<th class="num">${_mLabel(mk)}</th>`).join('')}<th class="num">Total</th></tr></thead>`;
  const line = (r) => `<tr><td>${esc(r.label)}${r.sub && d.by === 'children' ? ` <span class="mny-muted">${esc(r.sub)}</span>` : ''}</td>${
    d.months.map(mk => { const v = r.months[mk]; const n = _fcCell(v, view);
      return `<td class="num">${n ? fmt(n) : '<span class="mny-muted">—</span>'}${both && v && v.funding ? `<div class="mny-muted">${fmt(v.funding)} funded</div>` : ''}</td>`; }).join('')}<td class="num"><b>${fmt(r.total)}</b></td></tr>`;
  const tot = `<tr style="font-weight:800"><td>Total</td>${d.months.map(mk => { const t = d.totals[mk] || {}; const n = _fcCell(t, view);
    return `<td class="num">${fmt(n)}${both ? `<div class="mny-muted">${fmt(t.funding)} funded · ${t.children} children</div>` : ''}</td>`; }).join('')}<td class="num">${fmt(d.months.reduce((t, mk) => t + _fcCell(d.totals[mk], view), 0))}</td></tr>`;
  document.getElementById('fc-table').innerHTML = head + '<tbody>' + rows.map(line).join('') + tot + '</tbody>';
}
function forecastCsv() {
  if (!FC) return; const view = document.getElementById('fc-view').value;
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [[FC.by, ...FC.months, 'Total'].map(q).join(',')];
  for (const r of FC.rows) { const vals = FC.months.map(mk => (_fcCell(r.months[mk], view) / 100).toFixed(2)); lines.push([q(r.label), ...vals, (vals.reduce((t, v) => t + +v, 0)).toFixed(2)].join(',')); }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `income-forecast-${FC.months[0]}-to-${FC.months.at(-1)}-${view}.csv`; a.click();
}

const MAIN_TAB_INIT = { owes: initOwes, invoices: initInvoices, payments: initPayments, reconcile: initReconcile, funding: initFunding, families: initFamilies, forecast: initForecast };
const MAIN_TAB_DONE = new Set();
function showMainTab(name) {
  document.querySelectorAll('.wren-tab-bar[aria-label="Invoices and payments tabs"] [role="tab"]').forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle('wren-tab-active', active);
    t.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.v2-page > .mny-wrap > .wren-tab-panel[data-tab]').forEach(p => { p.hidden = p.dataset.tab !== name; });
  if (!MAIN_TAB_DONE.has(name) && MAIN_TAB_INIT[name]) { MAIN_TAB_INIT[name](); MAIN_TAB_DONE.add(name); }
}
function boot() {
  // b401 (2026-10-06) — this file is now also loaded on the child profile's Funding &
  // Invoices tab, which has no Money page tab bar. Only boot the Money page's own tabs when
  // the Money page's own root is actually on the page.
  const bar = document.querySelector('.wren-tab-bar[aria-label="Invoices and payments tabs"]');
  if (!bar) return;
  bar.querySelectorAll('[role="tab"]').forEach(tab =>
    tab.addEventListener('click', () => showMainTab(tab.dataset.tab)));
  // b481 port: /money.html#forecast (the Finance → Forecast banners link here) opens that tab.
  const want = String(location.hash || '').replace(/^#/, '');
  showMainTab(MAIN_TAB_INIT[want] ? want : 'owes');
}
document.addEventListener('wren:ready', boot);

// ══════════════════════════════════════════════════════════════════════════
// b535 (2026-10-29) — OUT OF DATE INVOICES
//
// "Changing booking patterns, changing whether they get funding or not, changing
// their sessions, changing their discounts… reissuing, generating new invoices when
// there's new information on the system, similar to how EyLog's one works."
//
// Three screens share this code, because they are three views of one question:
//   · the child profile's Billing changes panel — "This changes these invoices"
//   · Finance → Invoices and the Money page — the "Out of date (N)" chip and list
//   · the bulk actions on that list
// Every write goes through an EXISTING endpoint (/regenerate, /reissue, /carry-forward).
// Nothing here emails anything: a replacement is raised unsent, and the family only
// ever sees it when someone presses Send in the normal flow. The buttons say so.
// ══════════════════════════════════════════════════════════════════════════

/** 'YYYY-MM' for this month — the default floor for "still in play". */
function b535From() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function b535Diff(p) {
  // b535 review — "−£771.33", not "£-771.33".
  return (p > 0 ? '+' : p < 0 ? '−' : '') + fmt(Math.abs(p || 0));
}

/** One line of plain English: "November: £1,277.64 → £1,180.30 (day rate)." */
function b535Sentence(r) {
  const period = r.period_label || r.period || '';
  return `${esc(period)}: ${fmt(r.old_pence)} → ${fmt(r.new_pence)} (${esc(r.reason || 'recalculated')})`;
}

function b535StateLabel(r) {
  if (r.eylog) return pill('EyLog record', 'plain');
  if (r.paid) return pill('Sent · paid', 'ok');
  if (r.seen_by_family) return pill('Sent to the family', 'warn');
  return pill('Not sent yet', 'info');
}
// A bill that today would be £0 nearly always means the child's booking pattern has gone,
// not that the family owes nothing. Said out loud, and left out of "select all".
function b535ZeroWarning(r) {
  return r.would_zero ? ' ' + pill('£0 — check the booking', 'bad') : '';
}

// ── the three actions, each one call to an endpoint that already existed ─────
function b535Update(id) {
  return api(`/api/finance/invoices/${id}/regenerate`, { method: 'POST', body: { reason: 'Out-of-date check' } })
    .then(d => ({ ok: true, msg: `updated ${fmt(d.before_pence)} → ${fmt(d.after_pence)}` }));
}
function b535Carry(id) {
  return api(`/api/finance/invoices/${id}/carry-forward`, { method: 'POST', body: {} })
    .then(d => ({ ok: true, msg: d.direction === 'credit'
      ? `${fmt(Math.abs(d.diff_pence))} put on the account for ${d.target_period}`
      : `${fmt(d.diff_pence)} added to the ${d.target_period} invoice` }));
}
function b535Reissue(id) {
  // The bulk path: no preview modal, one invoice at a time, each in its own transaction
  // server-side (the G2 row lock in POST /reissue already stops a double click).
  return api(`/api/finance/invoices/${id}/reissue`, { method: 'POST', body: { reason: 'Out-of-date check — reissued' } })
    .then(d => ({ ok: true, msg: `credit note ${d.credit_note_invoice_number || ''}, replacement ${d.replacement_invoice_number || ''} (not emailed)` }));
}

const B535_CARRY_HELP =
  'Nothing is credited and nothing is reissued. A difference in the family’s favour goes on '
  + 'their account and comes off their next invoice; a difference owed to us is added to the next '
  + 'invoice as a correction line. This invoice itself is left exactly as the family has it. '
  + 'Nothing is emailed.';

function b535CarryWithConfirm(id, onDone) {
  ask('Put the difference on the next invoice',
      `<p>${B535_CARRY_HELP}</p>`, 'Carry it forward').then(okd => {
    if (!okd) return;
    b535Carry(id).then(r => { toast(r.msg, 'success'); if (onDone) onDone(); })
      .catch(e => toast(errText(e, 'Could not carry that difference'), 'warning'));
  });
}

function b535UpdateWithConfirm(id, onDone) {
  ask('Update this invoice',
      '<p>Re-prices this invoice from today’s booking pattern, funding, discounts, price '
      + 'overrides and extra sessions. It has not been sent to the family, so it is simply '
      + 'corrected in place. Nothing is emailed.</p>', 'Update invoice').then(okd => {
    if (!okd) return;
    b535Update(id).then(r => { toast('Invoice ' + r.msg, 'success'); if (onDone) onDone(); })
      .catch(e => toast(errText(e, 'Could not update that invoice'), 'warning'));
  });
}

// ── "This changes these invoices" ───────────────────────────────────────────
// Rendered under any save that moves the bill. `rows` is the save response's
// stale_invoices array, so the box costs no extra request.
function renderBillingImpact(host, rows, opts = {}) {
  const el = typeof host === 'string' ? document.getElementById(host) : host;
  if (!el) return;
  const onDone = opts.onDone || (() => {});
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="mny-note b535-impact b535-ok">Saved. No invoice changes because of it.</div>';
    return;
  }
  el.innerHTML = `
    <div class="mny-note b535-impact">
      <div class="b535-impact-head">This changes these invoices</div>
      <div class="b535-impact-rows">${rows.map(r => `
        <div class="b535-impact-row" data-inv="${r.invoice_id}">
          <div class="b535-impact-text">
            <div class="b535-impact-line">${b535Sentence(r)}</div>
            <div class="b535-impact-sub">${esc(r.invoice_number || '#' + r.invoice_id)} · ${b535StateLabel(r)}${b535ZeroWarning(r)}
              <span class="b535-impact-delta">${b535Diff(r.diff_pence)}</span></div>
            ${r.eylog ? '<div class="b535-impact-sub">Imported from EyLog — those figures are the historic record, so this one is never changed.</div>' : ''}
          </div>
          <div class="b535-impact-actions">
            ${r.action === 'regenerate'
              ? `<button type="button" class="mny-btn mny-btn-primary b535-btn" data-b535="update" data-id="${r.invoice_id}">Update invoice</button>`
              : ''}
            ${r.action === 'reissue'
              ? `<button type="button" class="mny-btn mny-btn-primary b535-btn" data-b535="reissue" data-id="${r.invoice_id}">Reissue…</button>`
              : ''}
            ${r.action !== 'regenerate'
              ? `<button type="button" class="mny-btn b535-btn" data-b535="carry" data-id="${r.invoice_id}">Put the difference on the next invoice</button>`
              : ''}
          </div>
        </div>`).join('')}</div>
      <div class="b535-impact-foot">A replacement invoice is raised <b>unsent</b>. The family sees it only when someone presses Send.</div>
    </div>`;
  el.querySelectorAll('[data-b535]').forEach(btn => btn.addEventListener('click', () => {
    const id = parseInt(btn.dataset.id, 10);
    if (btn.dataset.b535 === 'update') return b535UpdateWithConfirm(id, onDone);
    if (btn.dataset.b535 === 'carry') return b535CarryWithConfirm(id, onDone);
    if (btn.dataset.b535 === 'reissue') return openReissuePreviewModal(id, onDone);
  }));
}

// ── the "Out of date (N)" chip ──────────────────────────────────────────────
// Counts only — the chip must not ship every line of every invoice to render a number.
function loadStaleChip(host, opts = {}) {
  const el = typeof host === 'string' ? document.getElementById(host) : host;
  if (!el) return Promise.resolve(null);
  const from = opts.from || b535From();
  el.hidden = true;
  return api('/api/finance/invoices/stale/count?from=' + encodeURIComponent(from)).then(d => {
    const n = Number(d.count) || 0;
    el.hidden = false;
    el.textContent = n ? `Out of date (${n})` : 'All invoices up to date';
    el.classList.toggle('b535-chip-warn', n > 0);
    el.classList.toggle('b535-chip-ok', n === 0);
    el.disabled = n === 0;
    el.title = n
      ? `${n} invoice(s) from ${from} onwards no longer match today's bookings, funding, discounts or prices.`
      : `Every invoice from ${from} onwards matches today's figures.`;
    return d;
  }).catch(e => { el.hidden = true; console.warn('[b535] chip:', errText(e)); return null; });
}

// ── the list, with bulk actions ─────────────────────────────────────────────
let B535_ROWS = [];

function openStaleModal(opts = {}) {
  const from = opts.from || b535From();
  const onDone = opts.onDone || (() => {});
  api('/api/finance/invoices/stale?from=' + encodeURIComponent(from)).then(d => {
    B535_ROWS = d.invoices || [];
    Wren.modal(`Out of date — ${B535_ROWS.length} invoice${B535_ROWS.length === 1 ? '' : 's'}`, `
      <div class="b535-panel">
        <p class="mny-hint">Every invoice Wren raised for ${esc(from)} onwards whose figures no longer match
          today’s bookings, funding, discounts, price overrides and extra sessions.
          ${d.unpriceable ? `${d.unpriceable} could not be priced (the child has left, not started, or is no longer active) and are not listed.` : ''}</p>
        ${B535_ROWS.length ? `
        <div class="b535-bulkbar">
          <label class="b535-all"><input type="checkbox" id="b535-all"> Select all</label>
          <button type="button" class="mny-btn" id="b535-bulk-update">Update selected</button>
          <button type="button" class="mny-btn" id="b535-bulk-reissue">Reissue selected</button>
          <button type="button" class="mny-btn" id="b535-bulk-carry">Carry to next invoice</button>
          <span class="mny-muted" id="b535-selcount"></span>
          <span class="mny-muted b535-selnote" id="b535-selnote"></span>
        </div>
        <div class="mny-table-wrap">
          <table class="mny-alloc-table b535-table">
            <thead><tr><th></th><th>Child</th><th class="num">Billed → today</th>
              <th class="num">Difference</th><th>Why</th></tr></thead>
            <tbody>${B535_ROWS.map(r => `
              <tr data-inv="${r.invoice_id}"${r.would_zero ? ' class="b535-zero"' : ''}>
                <td><input type="checkbox" class="b535-sel" data-id="${r.invoice_id}"
                     data-action="${r.action}" data-zero="${r.would_zero ? '1' : '0'}"></td>
                <td class="b535-who">${esc(r.child_name || '#' + r.child_id)}
                  <div class="mny-muted b535-sub">${esc(r.period_label || r.period)}</div>
                  <div class="b535-sub">${b535StateLabel(r)}</div></td>
                <td class="num">${fmt(r.old_pence)}<div class="mny-muted b535-sub">${fmt(r.new_pence)}</div></td>
                <td class="num"><b>${b535Diff(r.diff_pence)}</b></td>
                <td class="mny-muted b535-why">${esc(r.reason || '')}${b535ZeroWarning(r)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="mny-hint">Totals: ${esc(String(d.scanned))} checked, ${esc(String(d.count))} out of date,
          ${b535Diff(d.total_diff_pence)} across all of them.</div>
        <div id="b535-progress" class="b535-progress" hidden></div>`
        : '<div class="mny-empty">Every invoice from this month onwards matches today’s figures.</div>'}
      </div>`, [{ label: 'Close' }]);
    if (!B535_ROWS.length) return;
    const selected = () => [...document.querySelectorAll('.b535-sel:checked')]
      .map(c => ({ id: parseInt(c.dataset.id, 10), action: c.dataset.action }));
    const syncCount = () => {
      const n = selected().length;
      const el = document.getElementById('b535-selcount');
      if (el) el.textContent = n ? `${n} selected` : '';
    };
    document.getElementById('b535-all').addEventListener('change', (e) => {
      // Deliberately NOT the would-£0 rows: those are almost always a missing booking
      // pattern, and sweeping them into a bulk Update would wipe real bills to nothing.
      // They can still be ticked one at a time, by someone who has looked.
      let skipped = 0;
      document.querySelectorAll('.b535-sel').forEach(c => {
        if (e.target.checked && c.dataset.zero === '1') { c.checked = false; skipped++; return; }
        c.checked = e.target.checked;
      });
      syncCount();
      const note = document.getElementById('b535-selnote');
      if (note) note.textContent = (e.target.checked && skipped)
        ? `${skipped} left out — they would become £0.00. Tick those yourself after checking the booking.` : '';
    });
    document.querySelectorAll('.b535-sel').forEach(c => c.addEventListener('change', syncCount));
    document.getElementById('b535-bulk-update').addEventListener('click', () =>
      b535RunBulk(selected().filter(r => r.action === 'regenerate'), b535Update, 'Update', onDone,
        'Only invoices the family has not seen can be updated in place.'));
    document.getElementById('b535-bulk-reissue').addEventListener('click', () =>
      b535RunBulk(selected().filter(r => r.action === 'reissue'), b535Reissue, 'Reissue', onDone,
        'Only invoices already sent to the family are reissued.'));
    document.getElementById('b535-bulk-carry').addEventListener('click', () =>
      b535RunBulk(selected(), b535Carry, 'Carry', onDone, ''));
  }).catch(e => toast(errText(e, 'Could not check for out-of-date invoices'), 'warning'));
}

// One at a time, in order, with a running result. Sequential on purpose: each reissue is
// its own server-side transaction, and firing twenty at once would have twenty of them
// competing for the same invoice_number sequence and the same family ledger.
function b535RunBulk(rows, fn, verb, onDone, emptyNote) {
  const box = document.getElementById('b535-progress');
  if (!rows.length) {
    if (box) { box.hidden = false; box.innerHTML = `<div class="mny-muted">Nothing selected that can be ${verb.toLowerCase()}d. ${esc(emptyNote || '')}</div>`; }
    return;
  }
  box.hidden = false;
  box.innerHTML = `<div class="b535-progress-head">${esc(verb)} — 0 of ${rows.length}…</div><div id="b535-log"></div>`;
  const log = document.getElementById('b535-log');
  let done = 0, ok = 0, failed = 0;
  const step = (i) => {
    if (i >= rows.length) {
      box.querySelector('.b535-progress-head').textContent =
        `${verb} finished — ${ok} done, ${failed} could not be done, of ${rows.length}.`;
      toast(`${verb}: ${ok} done, ${failed} failed`, failed ? 'warning' : 'success');
      onDone();
      return;
    }
    const r = rows[i];
    fn(r.id).then(res => {
      ok++; log.insertAdjacentHTML('beforeend', `<div class="b535-log-ok">#${r.id} — ${esc(res.msg)}</div>`);
    }).catch(e => {
      failed++; log.insertAdjacentHTML('beforeend', `<div class="b535-log-bad">#${r.id} — ${esc(errText(e))}</div>`);
    }).then(() => {
      done++;
      box.querySelector('.b535-progress-head').textContent = `${verb} — ${done} of ${rows.length}…`;
      step(i + 1);
    });
  };
  step(0);
}

// ── Reusable money actions for other pages (b401) — the child profile's Funding &
// Invoices tab calls these instead of copying these modals. One place, one version: this
// IS the Money page's own code, just also exposed by name. ──────────────────────────────
window.WrenMoney = {
  ask,
  openAddPaymentModal,
  openCreditNoteModal,
  openInvoiceDetail,
  openPaymentDetail,
  openEditPaymentModal,
  reversePayment,
  writeOffInvoice,
  regenerateInvoice,
  openGenerateInvoiceModal,
  downloadLedgerCsv,
  openOpeningBalanceModal,
  openOpeningBalanceHistory,
  openReissuePreviewModal,
  openPriceOverrideModal,
  // b535 — the out-of-date machinery, shared by the child profile's Billing changes
  // panel, the Money page and Finance → Invoices.
  renderBillingImpact,
  loadStaleChip,
  openStaleModal,
  carryForwardInvoice: b535CarryWithConfirm,
  updateStaleInvoice: b535UpdateWithConfirm,
  staleFromMonth: b535From,
};

})();
