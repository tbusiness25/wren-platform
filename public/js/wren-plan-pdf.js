/* wren-plan-pdf.js — b293 (2026-09-08)
 * ---------------------------------------------------------------------------
 * "Download PDF" for the termly planner: this half-term, or the whole year.
 *
 * Toby sends the planning out through EyLog, so it has to leave Wren as a file.
 * GET /api/planning/termly/pdf needs a Bearer token, so a plain <a href> cannot
 * fetch it — this does the fetch-to-blob dance instead (the same shape as the
 * parent-report download in editions/admin/public/reports.html).
 *
 * Lives in shared public/js and is mounted by BOTH planner pages (Roost
 * termly-plan.html and the EY Nest ey/termly-plan.html) so there is one
 * implementation, not two that drift.
 *
 *   WrenPlanPdf.mount('#some-empty-div', function () {
 *     return { room_id: 1, half_term_id: 3,        // or term_id for a legacy
 *              academic_year: '2026-2027',         // funding period
 *              termName: 'Spring 1', roomName: 'Baby Room',
 *              isDraft: true };
 *   });
 *
 * The draft state is only used for the warning line — the WATERMARK is decided
 * on the server from term_plans.status (b290), never from anything this file
 * sends, so a page that forgets to pass isDraft still cannot produce an
 * unmarked draft.
 */
;(function () {
  'use strict';
  if (window.WrenPlanPdf) return;

  function token() {
    try { return sessionStorage.getItem('wrenToken') || ''; } catch (e) { return ''; }
  }

  /* Chrome puts the name in Content-Disposition; keep it, because the server
     appends -DRAFT there and a saved-then-forwarded file should still say so. */
  function filenameFrom(resp, fallback) {
    var cd = resp.headers.get('Content-Disposition') || '';
    var m = /filename="?([^";]+)"?/.exec(cd);
    return (m && m[1]) || fallback;
  }

  function toast(text, kind) {
    if (window.Wren && Wren.toast) { Wren.toast(text, kind || 'info'); return; }
    if (kind === 'error') console.error('[plan-pdf]', text); else console.log('[plan-pdf]', text);
    // b328 (2026-09-11) — on a page without Wren.toast (the standalone termly-plan
    // pages) this used to end at the console, so a failed download looked like a
    // button that did nothing: Toby clicked "Download planning" and saw no reason.
    // Show it on the page. Theme tokens only.
    try {
      var el = document.createElement('div');
      el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      el.textContent = text;
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;' +
        'max-width:min(560px,92vw);padding:12px 16px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.25);background:var(--c-surface);color:var(--c-text);' +
        'border:2px solid ' + (kind === 'error' ? 'var(--c-danger)' : 'var(--c-line)');
      document.body.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, kind === 'error' ? 8000 : 4000);
    } catch (e) { /* the console line above still carries it */ }
  }

  function download(params, scope, btn) {
    var qs = ['room_id=' + encodeURIComponent(params.room_id)];
    if (scope === 'year') {
      qs.push('scope=year');
      if (params.academic_year) qs.push('academic_year=' + encodeURIComponent(params.academic_year));
      /* Send the selected period too. A legacy funding-period plan carries an
         academic_year of '2026', not '2026-2027', and the server derives the
         real one from the period's start date rather than refusing. */
      if (params.half_term_id) qs.push('half_term_id=' + encodeURIComponent(params.half_term_id));
      else if (params.term_id) qs.push('term_id=' + encodeURIComponent(params.term_id));
    } else if (params.half_term_id) {
      qs.push('half_term_id=' + encodeURIComponent(params.half_term_id));
    } else if (params.term_id) {
      qs.push('term_id=' + encodeURIComponent(params.term_id));
    } else {
      toast('Choose a half-term first', 'error'); return;
    }

    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Building…';
    fetch('/api/planning/termly/pdf?' + qs.join('&'),
          { headers: (window.Wren && Wren.authHeaders) ? Wren.authHeaders() : { Authorization: 'Bearer ' + token() } })
      .then(function (r) {
        var ct = r.headers.get('Content-Type') || '';
        if (!r.ok || ct.indexOf('pdf') < 0) {
          return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); },
                               function () { throw new Error('HTTP ' + r.status); });
        }
        var name = filenameFrom(r, 'planning.pdf');
        return r.blob().then(function (b) {
          var url = URL.createObjectURL(b);
          var a = document.createElement('a');
          a.href = url; a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          // Revoke late: Safari has not finished with the URL at click time.
          setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
          toast('Downloaded ' + name, 'success');
        });
      })
      .catch(function (e) { toast('Could not build the PDF: ' + e.message, 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = label; });
  }

  function css() {
    if (document.getElementById('wpp-css')) return;
    var s = document.createElement('style');
    s.id = 'wpp-css';
    /* Tokens only — no bare hex — with the documented LADN fallbacks so the
       block still themes on a page that has not loaded wren.css. */
    s.textContent =
      '.wpp{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:0 0 14px;' +
        'border:1px solid var(--c-border,#2d3748);background:var(--c-surface,#1e293b);' +
        'border-radius:12px;padding:10px 13px;font-size:.8rem;color:var(--c-text,#f1f5f9)}' +
      '.wpp .wpp-t{font-weight:700;flex:0 0 auto}' +
      '.wpp .wpp-w{flex:1 1 220px;color:var(--c-muted,#94a3b8);line-height:1.5}' +
      '.wpp button{background:transparent;border:1px solid var(--c-border,#2d3748);' +
        'color:var(--c-text,#f1f5f9);border-radius:10px;padding:8px 13px;font:inherit;' +
        'font-weight:600;cursor:pointer;min-height:38px;transition:border-color .2s,color .2s}' +
      '.wpp button:hover:not(:disabled){border-color:var(--c-primary,#4a9abf);color:var(--c-primary,#4a9abf)}' +
      '.wpp button:disabled{opacity:.6;cursor:default}' +
      '.wpp button.wpp-go{border-color:var(--c-accent,#e07820);color:var(--c-accent,#e07820)}';
    document.head.appendChild(s);
  }

  function mount(target, getParams) {
    var box = typeof target === 'string' ? document.querySelector(target) : target;
    if (!box) return null;
    css();
    box.className = 'wpp';
    box.innerHTML =
      '<span class="wpp-t">📄 Download</span>' +
      '<button type="button" class="wpp-go" data-wpp="term">⬇ This half-term</button>' +
      '<button type="button" data-wpp="year">⬇ The whole year</button>' +
      '<span class="wpp-w" data-wpp="warn"></span>';

    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-wpp]');
      if (!b) return;
      var p = getParams() || {};
      if (!p.room_id) { toast('Choose a playroom first', 'error'); return; }
      download(p, b.getAttribute('data-wpp'), b);
    });

    var api = {
      el: box,
      refresh: function () {
        var p = getParams() || {};
        box.querySelector('[data-wpp="warn"]').textContent = p.isDraft
          ? 'This half-term is still a draft, so its PDF is watermarked DRAFT on every page.'
          : 'A colourful, printable plan you can send to parents.';
      },
    };
    api.refresh();
    return api;
  }

  window.WrenPlanPdf = { mount: mount };
})();
