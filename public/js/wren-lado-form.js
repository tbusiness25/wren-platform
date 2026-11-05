/* wren-lado-form.js — renders a print-ready, editable LADO referral form.
 * Pre-fills from /api/safeguarding/:id/lado-data; opens in a new window for print / Save-as-PDF.
 * Area-configurable: the authority + LADO office block come from settings (Ealing defaults for LADN).
 * Loaded on demand from the Safeguarding section. No external deps — uses window.print().
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt)) return '';
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function lengthOfService(start) {
    if (!start) return '';
    const s = new Date(start); if (isNaN(s)) return '';
    const months = Math.max(0, Math.round((Date.now() - s.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
    if (months < 12) return months + ' month' + (months === 1 ? '' : 's');
    const y = Math.floor(months / 12), m = months % 12;
    return y + ' yr' + (y === 1 ? '' : 's') + (m ? ' ' + m + ' mo' : '');
  }

  // A single editable row: label + prefilled input/textarea
  function row(label, value, opts) {
    opts = opts || {};
    const v = esc(value || '');
    const field = opts.area
      ? `<textarea rows="${opts.rows || 3}">${v}</textarea>`
      : `<input type="text" value="${v}">`;
    return `<tr><th>${esc(label)}</th><td>${field}</td></tr>`;
  }

  function build(data) {
    const c = data.concern || {}, ch = data.child || {}, su = data.subject || {}, rf = data.referrer || {}, org = data.org || {}, lado = data.lado || {};
    const todayRef = c.referral_date ? fmtDate(c.referral_date) : fmtDate(new Date().toISOString());

    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>LADO Referral${ch.name ? ' — ' + esc(ch.name) : ''}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:0;background:#f3f4f6;font-size:13px;line-height:1.4}
  .toolbar{position:sticky;top:0;background:#1e293b;color:#fff;padding:10px 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:10}
  .toolbar button{background:#4a9abf;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}
  .toolbar button.secondary{background:#475569}
  .toolbar .note{font-size:12px;color:#fbbf24;flex:1;min-width:220px}
  .sheet{max-width:820px;margin:18px auto;background:#fff;padding:32px 36px;box-shadow:0 1px 8px rgba(0,0,0,.12)}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:#475569;font-size:12px;margin:0 0 4px}
  .ladobox{border:1px solid #cbd5e1;background:#f8fafc;border-radius:6px;padding:10px 14px;margin:14px 0;font-size:12px}
  h2{font-size:14px;background:#1e293b;color:#fff;padding:7px 12px;border-radius:5px;margin:22px 0 8px}
  table{width:100%;border-collapse:collapse;margin-bottom:6px}
  th{text-align:left;vertical-align:top;width:38%;padding:7px 10px;border:1px solid #e2e8f0;background:#f1f5f9;font-size:12px;font-weight:600}
  td{padding:4px 8px;border:1px solid #e2e8f0}
  input[type=text],textarea{width:100%;border:none;font-family:inherit;font-size:13px;padding:5px 4px;background:transparent;resize:vertical}
  input[type=text]:focus,textarea:focus{outline:2px solid #4a9abf55;background:#fffbe6}
  .hint{color:#94a3b8;font-size:11px;font-style:italic}
  @media print {
    body{background:#fff;font-size:12px}
    .toolbar{display:none}
    .sheet{box-shadow:none;margin:0;max-width:none;padding:0}
    input[type=text],textarea{outline:none}
    h2{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
</style></head>
<body>
<div class="toolbar">
  <button onclick="window.print()">🖨 Print / Save as PDF</button>
  <button class="secondary" onclick="window.close()">Close</button>
  <span class="note">Review every field before sending — fields are editable. ${esc(lado.note || '')}</span>
</div>
<div class="sheet">
  <h1>Referral to the Local Authority Designated Officer (LADO)</h1>
  <p class="sub">${esc(lado.authority || 'Local Authority')} — allegation against a member of staff or volunteer</p>
  <p class="sub">Submitted by: <strong>${esc(org.name)}</strong>${org.address ? ', ' + esc(org.address) : ''}${org.phone ? ' · ' + esc(org.phone) : ''}</p>
  <div class="ladobox">
    <strong>Send to:</strong> ${esc(lado.name || 'LADO')}${lado.phone ? ' · Tel ' + esc(lado.phone) : ''}${lado.email ? ' · ' + esc(lado.email) : ''}
  </div>

  <h2>1. Referrer details</h2>
  <table>
    ${row('Date of incident', fmtDate(c.incident_date))}
    ${row('Date of referral', todayRef)}
    ${row('Reason for delay (if more than 24 hrs since incident)', '')}
    ${row("Referrer's name", rf.name)}
    ${row("Referrer's job title", rf.job_title)}
    ${row('Place of employment (address incl. postcode)', [org.name, org.address].filter(Boolean).join(', '))}
    ${row("Referrer's email address", rf.email)}
    ${row("Referrer's telephone number", rf.phone || org.phone)}
    ${row('If a school: contact details for head and chair of governors', '')}
    ${row('Contact details for another DSL if unavailable', c.safeguarding_lead)}
  </table>

  <h2>2. Details of the member of staff / volunteer (subject of the allegation)</h2>
  <table>
    ${row('Full name', su.name)}
    ${row('Job title', su.role || '')}
    ${row('Do they work with children or adults?', su.name ? 'Children' : '')}
    ${row('Date of birth', fmtDate(su.date_of_birth))}
    ${row('Languages spoken and ethnicity', '')}
    ${row('Gender', '')}
    ${row('Full home address', su.address || '')}
    ${row('Contact number', su.phone || '')}
    ${row('Employed through an agency? (Yes/No)', '')}
    ${row('If yes: agency contact details and main contact', '')}
    ${row('Length of employment with your organisation', lengthOfService(su.contract_start))}
    ${row('Do they work anywhere else with children? (Yes/No)', '')}
    ${row('Do they have children of their own? (Yes/No)', '')}
    ${row('Does the subject know LADO has been contacted?', '')}
    ${row('Has HR been contacted? If so, their view?', '')}
    ${row('Main category of abuse (Physical/Sexual/Emotional/Neglect/Other)', c.category)}
  </table>

  <h2>3. Full details of the allegation</h2>
  <table>${row('Please provide full details of the allegation', c.allegation, { area: true, rows: 8 })}</table>

  <h2>4. Details of the potential victim / child</h2>
  <table>
    ${row('Full name of child(ren)', ch.name)}
    ${row('Full address(es) of child(ren)', ch.address)}
    ${row('Date of birth', fmtDate(ch.dob))}
    ${row('Disabilities / SEN needs? (Yes/No + details)', ch.sen)}
    ${row("Child's ethnicity (if known)", ch.ethnicity)}
    ${row("Have the child's parents been contacted? Their view?", '')}
    ${row("If the child has a social worker: name & contact", '')}
    ${row("Has the social worker been notified? Their view?", '')}
    ${row('Is the child in a foster placement? (Looked After)', ch.looked_after ? 'Yes — Looked After' : '')}
    ${row('Interim safeguarding put in place to keep the child safe', c.immediate_action)}
  </table>

  <p class="hint">Generated by Wren from concern #${esc(c.id)} on ${fmtDate(new Date().toISOString())}. Verify all details and the current LADO contact before sending.</p>
</div>
</body></html>`;
  }

  window.WrenLadoForm = {
    open(data) {
      const w = window.open('', '_blank');
      if (!w) { alert('Pop-up blocked — please allow pop-ups to generate the LADO referral form.'); return; }
      w.document.open();
      w.document.write(build(data));
      w.document.close();
    },
  };
})();
