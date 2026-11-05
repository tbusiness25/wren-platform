'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Onboarding — PUBLIC, token-gated self-service forms (no login, rate-limited).
// Mounted in server-unified.js BEFORE the auth-gated routes, portal-agnostic
// (matches on path, any host). A single-use invite token (minted by a manager in
// Roost) is the access control.
//
//   GET  /onboard/child?token=…   GET  /onboard/staff?token=…   → the form pages
//   POST /api/onboard/child       POST /api/onboard/staff       → submissions
//
// Every submission creates an INACTIVE / status='pending' record in the tenant
// schema of the SERVING edition (getPool() → that container's schema) and marks
// the invite 'submitted'. Nothing becomes live until a manager approves it in
// Roost. Personal data submitted here is NEVER written to logs.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getPool } = require('../db/pool');
const { loadInvite } = require('../lib/onboarding-invites-db');
// b321 — the photos and medical documents a family sends when their child starts.
const CD = require('../lib/child-documents');
// b325 — the Tax-Free Childcare reference collected on the registration form.
const PAYREF = require('../lib/payment-references');
// b398 — the pipeline moves forward on its own, and never backwards.
const { tryAdvanceToRegistered } = require('../lib/enquiry-stage');

// Own JSON parser — the server-level express.json runs later (after auth).
// 2026-10-20 (fix-feedback-voice): scoped to this router's own paths. Mounted at the app ROOT
// (server-unified.js, before the global express.json({limit:'20mb'})), an unscoped router.use(express.json)
// ran on EVERY request and, first parser wins, capped every JSON body in Wren at this limit — so
// every bug report with a screenshot (and any other JSON write over the cap) 413'd before auth.
router.use('/api/onboard', express.json({ limit: '64kb' }));

const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});
const pageLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
// b321 — a family sends four or five files in one sitting, sometimes twice
// because the first photo was the wrong way up. Looser than submitLimiter
// (which guards a single-use form) and tighter than the page limiter.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many uploads in a short time. Please wait a few minutes and try again.' },
});

// ── input helpers ─────────────────────────────────────────────────────────────
function clean(v, maxLen) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s{3,}/g, ' ').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s || null;
}
function cleanDate(v) { const s = clean(v, 20); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
function truthy(v) { return v === true || v === 'true' || v === 'on' || v === '1' || v === 1; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ── page chrome ────────────────────────────────────────────────────────────────
function page(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} — Your Nursery</title>
<style>
  :root{--brand:#e07820;--blue:#4a9abf;--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--bg:#fbf7f0}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  .wrap{max-width:640px;margin:0 auto;padding:20px 16px 60px}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  h1{font-size:1.35rem;margin:0 0 4px}
  .sub{color:var(--muted);font-size:.9rem;margin:0 0 18px}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:16px;font-weight:800;color:var(--brand)}
  .brand .dot{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--brand))}
  fieldset{border:0;border-top:1px solid var(--line);margin:18px 0 0;padding:16px 0 0}
  legend{font-weight:700;font-size:.95rem;color:var(--ink);padding:0}
  label{display:block;font-size:.82rem;font-weight:600;color:#374151;margin:12px 0 4px}
  .req::after{content:' *';color:var(--brand)}
  input,textarea,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font-size:1rem;font-family:inherit;background:#fff}
  input:focus,textarea:focus,select:focus{outline:2px solid var(--blue);border-color:var(--blue)}
  textarea{min-height:70px;resize:vertical}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:520px){.row{grid-template-columns:1fr}}
  .chk{display:flex;align-items:flex-start;gap:10px;margin-top:12px;font-size:.9rem;font-weight:500;color:#374151}
  .chk input{width:auto;margin-top:2px}
  .btn{margin-top:22px;width:100%;padding:13px;border:0;border-radius:10px;background:linear-gradient(135deg,var(--blue),var(--brand));color:#fff;font-size:1.02rem;font-weight:800;cursor:pointer}
  .btn:disabled{opacity:.6;cursor:default}
  .err{display:none;margin-top:12px;padding:10px 12px;border-radius:9px;background:#fef2f2;color:#b91c1c;font-size:.86rem}
  .foot{text-align:center;color:var(--muted);font-size:.78rem;margin-top:18px}
  .ok{text-align:center;padding:20px 6px}
  .ok .big{font-size:2.6rem}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  /* b274 — Terms & Conditions block. This page is standalone (no Wren shell, no
     token stylesheet), so it keeps its own literal palette exactly as the rest
     of this file already does. */
  .tc-note{background:#fffaf3;border:1px solid #f3d9b8;border-left:3px solid var(--brand);
    border-radius:9px;padding:12px 14px;font-size:.86rem;line-height:1.55;color:#4b5563}
  .tc-note b{color:var(--ink)}
  .tc-note p{margin:8px 0}
  .tc-note ul{margin:8px 0;padding-left:20px}
  .tc-note li{margin:5px 0}
  .tc-full{margin-top:12px;border:1px solid var(--line);border-radius:9px;background:#fff}
  .tc-full summary{cursor:pointer;padding:10px 12px;font-size:.86rem;font-weight:700;color:var(--blue)}
  .tc-doc{white-space:pre-wrap;font-size:.8rem;line-height:1.6;color:#4b5563;
    max-height:44vh;overflow-y:auto;padding:0 14px 14px;border-top:1px solid var(--line)}
</style></head><body><div class="wrap">
  <div class="brand"><span class="dot"></span> Your Nursery</div>
  <div class="card">${inner}</div>
  <div class="foot">Your Nursery · Ealing, AB1 2CD · This is a secure single-use form.</div>
</div></body></html>`;
}

function gonePage(why) {
  const msg = why === 'expired'
    ? 'This link has expired. Please contact the nursery for a new one.'
    : why === 'submitted' || why === 'approved'
      ? 'This form has already been completed. Thank you — there is nothing more to do.'
      : 'This link is not valid. Please check the link the nursery sent you, or get in touch.';
  return page('Link unavailable',
    `<h1>Link no longer available</h1><p class="sub">${esc(msg)}</p>
     <p style="color:#6b7280;font-size:.85rem">Your Nursery · 123 Example Lane, AB1 2CD</p>`);
}

// ── b274 — the Terms & Conditions, presented at enrolment ──────────────────────
// b249 recorded that there was NO parent T&C submission point anywhere on prod:
// consents.html is per-child toggles, declaration.html is the FEEE funding form,
// contracts.js is STAFF employment contracts, and this form collected a child's
// details without ever showing a family the terms they were agreeing to. This is
// that submission point.
//
// Nothing is invented for it. The document is a normal ladn.policies row
// (parent_facing + requires_parent_signature) and the acceptance goes into
// parent_policy_acknowledgments — the same table and the same UNIQUE key
// (policy_id, parent_email, policy_version) the portal signing page writes to,
// with source='enrolment', which POST /welcome/policies/api/sign already
// anticipated as the distinguishing value.
//
// LOOKED UP BY TITLE because ladn_policies_title_uq makes the title the row's
// identity, and the id differs between dev and prod (b249 was caught by exactly
// that). If the row is absent — every demo edition, and any tenant that has not
// imported one — `terms` is null, the fieldset is not rendered and nothing is
// required. The form then behaves exactly as it did before this build.
// b285 — the callout below the heading is now the DOCUMENT'S own "CLOSURES"
// section, parsed out of terms.content, not a paraphrase typed into this file.
// b274 wrote the closures rule out by hand here, in guide.html and in fees.html;
// three hand-kept copies of a contractual term is three chances to disagree with
// what the family actually signed.
const termsDoc = require('../lib/terms-doc');

const TERMS_TITLE = 'Terms and Conditions';

async function loadTerms() {
  try {
    const { rows } = await getPool().query(
      `SELECT id, title, content, version, version_label, effective_date
         FROM policies
        WHERE title = $1 AND is_active = true
          AND parent_facing = true AND requires_parent_signature = true`, [TERMS_TITLE]);
    return rows[0] || null;
  } catch (e) {
    // A tenant whose schema predates the parent-signature columns must still be
    // able to register a child. Never let this break the form.
    console.error('[onboard] terms lookup failed:', e.message);
    return null;
  }
}

const fmtDate = d => {
  if (!d) return '';
  // pg hands back DATE as a local-midnight Date; use local getters, never
  // toISOString() (memory/reference_pg_date_ymd_trap.md).
  const dt = d instanceof Date ? d : new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

// The fieldset. The FULL text is embedded — not a link, not a summary — because
// this is the moment of acceptance and the record we keep says the family read
// this version. The closure/billing terms are pulled out above it in plain sight
// so that "you are paying for days we are closed" is not something a parent has
// to go looking for inside 15,000 characters.
function termsFieldset(terms) {
  if (!terms) return '';
  const v = esc(terms.version_label || String(terms.version));
  const eff = terms.effective_date ? ` · in force from ${esc(fmtDate(terms.effective_date))}` : '';
  // The callout is a SECTION OF THE DOCUMENT, quoted. If a tenant's T&C has no
  // "CLOSURES" heading the callout is simply not rendered — the full text and
  // the acceptance still are, so the form never depends on this setting's own
  // section headings.
  let closures = '';
  try {
    const sec = termsDoc.section(terms.content, 'CLOSURES');
    if (sec) {
      closures = `<div class="tc-note">
          <b>Before you agree, the part about closures and billing — quoted from the document:</b>
          ${termsDoc.sectionHtml(terms.content, 'CLOSURES')}
        </div>`;
    }
  } catch (e) {
    console.error('[onboard] terms closures section:', e.message);
  }

  return `
      <fieldset><legend>Terms &amp; Conditions</legend>
        <p style="font-size:.84rem;color:#6b7280;margin:8px 0 10px">Version ${v}${eff}</p>
        ${closures}
        <details class="tc-full">
          <summary>Read the full Terms &amp; Conditions</summary>
          <div class="tc-doc">${esc(terms.content || '')}</div>
        </details>
        <label class="chk"><input type="checkbox" id="tc" required>
          I have read and accept the Terms &amp; Conditions, version ${v} — including the
          section above on closures and 52-week fees.</label>
      </fieldset>`;
}

// ── b303 — the HMRC starter checklist's questions, on the form she already fills
// ─────────────────────────────────────────────────────────────────────────────
// Toby, 2026-09-10: "…and then all their details are pulled into Wren directly
// yeah?" Two of the three were already true. The handbook goes out with the
// welcome email, and b288 added HMRC's starter checklist to the pack — but as a
// GOV.UK LINK. She downloads a PDF, fills it in, hands it back on paper, and
// somebody re-types it, which is the one thing this whole flow exists to stop.
//
// So the questions move onto the form, and the answers go straight to
// ladn.staff. The GOV.UK pack row STAYS ACTIVE and its wording is untouched:
// somebody with a P45, or who would rather use the official form, must still be
// able to.
//
// THREE THINGS THIS IS CAREFUL NOT TO DO:
//   1. It never claims to file anything. PURPOSE_LINE says, in one sentence,
//      that this is the nursery collecting what it needs to run PAYE. There is
//      no HMRC logo, no crown, and no facsimile of HMRC's form here.
//   2. It never blocks. Every field is optional at the form level. A starter
//      with no NI number yet still gets an account.
//   3. It never widens what the token can read. This adds inputs to a page the
//      token already opened and columns to the row it already wrote.
//
// The wording of the three employee statements is HMRC's own, held once in
// src/lib/hmrc-starter.js so the form, the validator and the Roost screen cannot
// drift apart. (b288 learned that lesson with the fire induction.)
const hmrc = require('../lib/hmrc-starter');

function payrollFieldset() {
  const decs = hmrc.DECLARATIONS.map(d => `
        <label class="chk pay-opt">
          <input type="radio" name="dec" value="${esc(d.letter)}">
          <span><b>${esc(d.letter)}</b> — ${esc(d.statement)}
          ${d.caveat ? `<span class="pay-caveat">${esc(d.caveat)}</span>` : ''}</span>
        </label>`).join('');
  const plans = hmrc.STUDENT_LOAN_PLANS
    .map(p => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('');
  return `
      <fieldset><legend>Payroll</legend>
        <p class="pay-note">${esc(hmrc.PURPOSE_LINE)}</p>
        <label for="ni">National Insurance number</label>
        <input id="ni" autocapitalize="characters" spellcheck="false" placeholder="AB 12 34 56 C">
        <p class="pay-hint">On your payslip, P45 or a letter from HMRC. Leave it blank if you have not been given one yet.</p>

        <label class="chk"><input type="checkbox" id="p45">
          I have a P45 from a job I left this tax year, and I will bring it in.</label>
        <p class="pay-hint">If you have one, you can skip the three statements below — a P45 takes their place.</p>

        <div id="dec-block">
          <label style="margin-top:14px">Which of these describes you? Choose one.</label>
          ${decs}
        </div>

        <label for="sl">Student loan</label>
        <select id="sl">
          <option value="">Prefer not to say / not sure</option>
          ${plans}
        </select>
        <label class="chk"><input type="checkbox" id="pgl">
          I also have a Postgraduate Loan.</label>
      </fieldset>`;
}

// Scoped to the payroll block. Same rule as every other style in this file: the
// starter-facing pages are standalone, load no Wren stylesheet, and so carry a
// literal palette — but no value here is a colour the page did not already use.
const PAYROLL_CSS = `<style>
  .pay-note{background:#fffaf3;border:1px solid #f3d9b8;border-left:3px solid var(--brand);
    border-radius:9px;padding:11px 13px;font-size:.84rem;line-height:1.55;color:#4b5563;margin:8px 0 4px}
  .pay-hint{font-size:.78rem;color:var(--muted);line-height:1.5;margin:5px 0 0}
  .pay-opt{align-items:flex-start;line-height:1.5}
  .pay-opt b{color:var(--ink)}
  .pay-caveat{display:block;font-size:.78rem;color:var(--muted);margin-top:3px}
  .pay-read{margin-top:14px;border:1px solid var(--line);border-radius:10px;background:#fff;padding:0}
  .pay-read summary{cursor:pointer;padding:11px 13px;font-size:.85rem;font-weight:700;color:var(--blue)}
  .pay-read dl{margin:0;padding:0 13px 13px;border-top:1px solid var(--line);font-size:.85rem}
  .pay-read dt{font-weight:700;color:var(--ink);margin-top:10px;font-size:.8rem}
  .pay-read dd{margin:2px 0 0;color:#4b5563;line-height:1.5}
</style>`;

// Resolve a page request's invite; returns { ok, inv } or sends a gone page.
async function gate(req, res, type) {
  const inv = await loadInvite(req.query.token, type);
  if (!inv) { res.status(404).type('html').send(gonePage('invalid')); return null; }
  if (inv.status !== 'pending') { res.status(410).type('html').send(gonePage(inv.status)); return null; }
  return inv;
}

// ── CHILD form page ─────────────────────────────────────────────────────────────
router.get('/onboard/child', pageLimiter, async (req, res) => {
  const inv = await gate(req, res, 'child'); if (!inv) return;
  const terms = await loadTerms();   // b274 — null on any tenant without a T&C row
  res.type('html').send(page('Register your child', `
    <h1>Register your child</h1>
    <p class="sub">Please tell us about your child so we can get everything ready. The nursery will confirm the place once they've reviewed your details.</p>
    <form id="f" autocomplete="on">
      <input type="hidden" id="token" value="${esc(req.query.token)}">
      <input type="text" class="hp" id="company" tabindex="-1" autocomplete="off" aria-hidden="true">
      <fieldset><legend>Child</legend>
        <div class="row">
          <div><label class="req" for="first">First name</label><input id="first" required></div>
          <div><label class="req" for="last">Last name</label><input id="last" required></div>
        </div>
        <div class="row">
          <div><label for="pref">Preferred name</label><input id="pref"></div>
          <div><label for="dob">Date of birth</label><input id="dob" type="date"></div>
        </div>
        <label for="start">Preferred start date</label><input id="start" type="date">
      </fieldset>
      <fieldset><legend>Parent / carer 1</legend>
        <div class="row">
          <div><label class="req" for="p1n">Full name</label><input id="p1n" required></div>
          <div><label for="p1p">Phone</label><input id="p1p" type="tel" inputmode="tel"></div>
        </div>
        <label class="req" for="p1e">Email</label><input id="p1e" type="email" required>
      </fieldset>
      <fieldset><legend>Parent / carer 2 (optional)</legend>
        <div class="row">
          <div><label for="p2n">Full name</label><input id="p2n"></div>
          <div><label for="p2p">Phone</label><input id="p2p" type="tel" inputmode="tel"></div>
        </div>
        <label for="p2e">Email</label><input id="p2e" type="email">
      </fieldset>
      <fieldset><legend>Emergency contacts</legend>
        <div class="row">
          <div><label for="e1n">Contact 1 name</label><input id="e1n"></div>
          <div><label for="e1p">Contact 1 phone</label><input id="e1p" type="tel" inputmode="tel"></div>
        </div>
        <div class="row">
          <div><label for="e2n">Contact 2 name</label><input id="e2n"></div>
          <div><label for="e2p">Contact 2 phone</label><input id="e2p" type="tel" inputmode="tel"></div>
        </div>
      </fieldset>
      <fieldset><legend>Health</legend>
        <div class="row">
          <div><label for="gpn">GP name / surgery</label><input id="gpn"></div>
          <div><label for="gpp">GP phone</label><input id="gpp" type="tel" inputmode="tel"></div>
        </div>
        <label for="alg">Allergies</label><input id="alg" placeholder="None">
        <label for="diet">Dietary requirements</label><input id="diet" placeholder="None">
        <label for="med">Medical notes</label><textarea id="med"></textarea>
      </fieldset>
      <fieldset><legend>Paying us</legend>
        <label for="tfc">Tax-Free Childcare reference (optional)</label>
        <input id="tfc" maxlength="12" autocapitalize="characters" spellcheck="false"
               placeholder="e.g. AJON12345">
        <p class="hint" id="tfc-hint">If you pay through your HMRC Tax-Free Childcare account, enter your
          child&rsquo;s childcare reference &mdash; four letters then five digits. It means your payments
          find your account on their own. Leave it blank if you do not use the scheme.</p>
      </fieldset>
      <fieldset><legend>Consents</legend>
        <label class="chk"><input type="checkbox" id="photo"> I consent to photographs of my child being used internally (e.g. learning journals, observations).</label>
        <label class="chk"><input type="checkbox" id="media"> I consent to my child's images being used in nursery publicity / social media.</label>
      </fieldset>
      ${termsFieldset(terms)}
      <button class="btn" id="go" type="submit">Submit registration</button>
      <div class="err" id="err"></div>
    </form>
    <script>${FORM_JS('child', !!terms)}</script>
  `));
});

// ─────────────────────────────────────────────────────────────────────────────
// b321 — PHOTOS AND DOCUMENTS AT REGISTRATION
//
// Toby: "when a new family starts we ask for them to send us an A4 sized family
// picture... and also a little bit bigger than passport sized portrait for their
// peg. they can upload this when they fill out the registration form on Wren."
//
// WHY THIS IS A SECOND PAGE AND NOT A FIELD ON THE FIRST
//
// The child row does not exist until the form is submitted, and a file has to
// belong to a child. Holding uploads in memory across a multi-step form, or
// parking them in a limbo table to be re-pointed later, are both ways of losing
// a family's photos to a dropped connection. So: submit the details, get a
// child, then upload against that child. The family is redirected here
// automatically and can come back to the same link later — the photo they meant
// to send is on the other phone, every time.
//
// THE AUTHORISATION IS THE INVITE ROW, NEVER THE REQUEST
//
// The child id comes off invite.submitted_entity_id. The uploader cannot name a
// child, so "a parent cannot upload to another child's documents" is not a check
// that could be forgotten — there is no parameter to check. The window closes 30
// days after submission, by which time the family has the Finch portal, which
// has its own per-parent scoping.
// ─────────────────────────────────────────────────────────────────────────────

const PHOTO_WINDOW_DAYS = 30;

/**
 * Resolve a token to { invite, childId } for the upload flow, or write the
 * refusal itself and return null. `asJson` picks the shape of the refusal.
 */
async function photoGate(req, res, token, asJson) {
  const deny = (code, why, msg) => {
    if (asJson) res.status(code).json({ error: msg });
    else res.status(code).type('html').send(gonePage(why));
    return null;
  };
  const inv = await loadInvite(token, 'child');
  if (!inv) return deny(404, 'invalid', 'This link is not valid.');
  if (!['submitted', 'approved'].includes(inv.status)) {
    return deny(410, inv.status,
      'Please fill in the registration form first — the upload page opens once your details are in.');
  }
  if (!inv.submitted_entity_id) {
    return deny(410, 'invalid', 'We could not match this link to a child record. Please contact the nursery.');
  }
  const since = inv.submitted_at ? (Date.now() - new Date(inv.submitted_at).getTime()) / 86400000 : 0;
  if (since > PHOTO_WINDOW_DAYS) {
    return deny(410, 'expired',
      'This upload link has closed. You can still send us photos and documents from the parents app.');
  }
  return { invite: inv, childId: Number(inv.submitted_entity_id) };
}

// Family-facing types, in the order they are asked for.
const PHOTO_STEPS = ['family_photo', 'peg_portrait', 'allergy_doc', 'medicine_doc', 'health_care_plan'];

function uploadStepHtml(key) {
  const t = CD.DOC_TYPES[key];
  const accept = t.accept.map(m => ({
    'image/jpeg': '.jpg,.jpeg', 'image/png': '.png',
    'image/webp': '.webp', 'application/pdf': '.pdf',
  }[m] || '')).join(',');
  return `<div class="up" data-cat="${esc(key)}">
    <div class="up-head"><span class="up-ic">${t.icon}</span>
      <div><div class="up-t">${esc(t.label)}</div>
      <div class="up-b">${esc(t.blurb)}</div></div></div>
    <div class="up-hint">${esc(t.hint)}</div>
    <input type="file" accept="${esc(accept)}" class="up-file">
    <button type="button" class="up-go">Upload</button>
    <div class="up-msg"></div>
    <div class="up-have"></div>
  </div>`;
}

const PHOTO_CSS = `
  .up{border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:14px;background:#fff}
  .up-head{display:flex;gap:10px;align-items:flex-start}
  .up-ic{font-size:1.5rem;line-height:1}
  .up-t{font-weight:800;font-size:.98rem}
  .up-b{font-size:.85rem;color:var(--muted);margin-top:2px}
  .up-hint{font-size:.78rem;color:var(--muted);margin:8px 0 6px;font-style:italic}
  .up-file{font-size:.85rem;padding:8px}
  .up-go{margin-top:8px;width:100%;padding:10px;border:0;border-radius:9px;
    background:var(--blue);color:#fff;font-weight:800;cursor:pointer;font-size:.92rem}
  .up-go:disabled{opacity:.55;cursor:default}
  .up-msg{font-size:.82rem;margin-top:7px;min-height:1em}
  .up-msg.bad{color:#b91c1c}.up-msg.good{color:#15803d}
  .up-have{font-size:.78rem;color:#15803d;margin-top:5px}
  .privacy{margin-top:20px;padding:12px 14px;border-radius:10px;background:#f0f7fb;
    border:1px solid #cfe4ef;font-size:.82rem;line-height:1.55;color:#374151}
  .privacy b{color:var(--ink)}
  .done{margin-top:20px;text-align:center;font-size:.85rem;color:var(--muted)}`;

// ── the upload page ──────────────────────────────────────────────────────────
router.get('/onboard/child/photos', pageLimiter, async (req, res) => {
  const g = await photoGate(req, res, req.query.token, false);
  if (!g) return;
  res.type('html').send(page('Photos and documents', `
    <style>${PHOTO_CSS}</style>
    <h1>Photos and documents</h1>
    <p class="sub">Thank you — your child's details are with the nursery. There are a few
      things we ask families to send us. You can do them now, or come back to this same
      link any time in the next ${PHOTO_WINDOW_DAYS} days.</p>
    <input type="hidden" id="token" value="${esc(req.query.token)}">
    ${PHOTO_STEPS.map(uploadStepHtml).join('')}
    <div class="privacy">
      <b>What happens to these.</b> They go straight into your child's file, where only
      nursery staff can see them. We remove the hidden location data that phones add to
      photos before we store anything. The two photos are yours — we print them, and we
      offer them back and delete them when your child leaves. Allergy and medicine
      documents we have to keep for three years after your child leaves.
      Nothing here is ever emailed, posted publicly, or shown to another family.
    </div>
    <div class="done">All finished? You can simply close this page.</div>
    <script>${PHOTO_JS}</script>
  `));
});

const PHOTO_JS = `
(function(){
  var token=document.getElementById('token').value;
  function refresh(){
    fetch('/api/onboard/child/uploads?token='+encodeURIComponent(token))
      .then(function(r){return r.ok?r.json():{documents:[]};})
      .then(function(j){
        var by={};(j.documents||[]).forEach(function(d){by[d.category]=(by[d.category]||0)+1;});
        Array.prototype.forEach.call(document.querySelectorAll('.up'),function(box){
          var n=by[box.getAttribute('data-cat')]||0;
          box.querySelector('.up-have').textContent = n ? ('\\u2713 '+n+' already sent \\u2014 you can send another if you need to') : '';
        });
      }).catch(function(){});
  }
  Array.prototype.forEach.call(document.querySelectorAll('.up'),function(box){
    var file=box.querySelector('.up-file'), go=box.querySelector('.up-go'), msg=box.querySelector('.up-msg');
    go.addEventListener('click',function(){
      if(!file.files||!file.files[0]){msg.className='up-msg bad';msg.textContent='Choose a file first.';return;}
      var fd=new FormData();
      fd.append('token',token);
      fd.append('category',box.getAttribute('data-cat'));
      fd.append('file',file.files[0]);
      go.disabled=true;msg.className='up-msg';msg.textContent='Uploading\\u2026';
      fetch('/api/onboard/child/upload',{method:'POST',body:fd})
        /* A 413 comes from NGINX, not from Wren: the proxy in front of this page
           rejects the body before the route sees it, and its reply is an HTML
           error page. r.json() on that throws "Unexpected token <", which tells
           a parent nothing. Read it as text and decide from the status. */
        .then(function(r){return r.text().then(function(t){
          var j=null; try{ j=JSON.parse(t); }catch(e){}
          return {ok:r.ok,status:r.status,j:j};
        });})
        .then(function(x){
          if(x.status===413) throw new Error('That file is too large to send through our upload form. Please choose a smaller photo, or email it to the nursery.');
          if(!x.ok) throw new Error((x.j&&x.j.error)||'Upload failed. Please try again.');
          msg.className='up-msg good';msg.textContent='Sent \\u2713 thank you.';
          file.value='';refresh();
        })
        .catch(function(e){msg.className='up-msg bad';msg.textContent=e.message;})
        .then(function(){go.disabled=false;});
    });
  });
  refresh();
})();`;

// ── what has this family already sent? (counts + labels only) ────────────────
router.get('/api/onboard/child/uploads', uploadLimiter, async (req, res) => {
  const g = await photoGate(req, res, req.query.token, true);
  if (!g) return;
  try {
    const { rows } = await getPool().query(
      `SELECT category, title, uploaded_at FROM person_documents
        WHERE subject_type='child' AND subject_id=$1 AND deleted=false
          AND category = ANY($2::text[])
        ORDER BY uploaded_at`, [g.childId, PHOTO_STEPS]);
    res.json({ documents: rows });
  } catch (e) {
    console.error('[onboard/photos] list failed:', e.message);
    res.status(500).json({ error: 'Could not load your uploads.' });
  }
});

// ── the upload itself ────────────────────────────────────────────────────────
// memoryStorage: the file is inspected, cleaned and only THEN written, so there
// is never a moment where an un-sniffed, EXIF-carrying file sits on disk under a
// name an uploader chose. The 20MB cap is multer's; the per-type cap is
// child-documents.js's and is the one that produces a useful message.
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

router.post('/api/onboard/child/upload', uploadLimiter, (req, res) => {
  photoUpload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({
        error: err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is too large. Please send one under 20MB.' : 'We could not read that upload.',
      });
    }
    const g = await photoGate(req, res, (req.body || {}).token, true);
    if (!g) return;

    const category = String((req.body || {}).category || '');
    if (!CD.DOC_TYPES[category]) return res.status(400).json({ error: 'Unknown document type.' });
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'No file was received.' });
    }

    const chk = CD.inspectAndClean(req.file.buffer, category);
    if (!chk.ok) return res.status(400).json({ error: chk.error });

    try {
      const db = getPool();
      // Same store as every other child document (b104), so the file is visible
      // to the profile panel, the b308 archive and the retention sweep without
      // any of them learning about a new place to look.
      const base = process.env.PERSON_DOC_BASE || path.join(__dirname, '../../data/person-documents');
      const dir = path.join(base, 'child', String(g.childId));
      fs.mkdirSync(dir, { recursive: true });
      const name = `reg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${chk.ext}`;
      const full = path.join(dir, name);
      fs.writeFileSync(full, chk.buffer);

      const spec = CD.DOC_TYPES[category];
      const { rows: [doc] } = await db.query(
        `INSERT INTO person_documents
           (subject_type, subject_id, title, category, filename, stored_path, mime, size_bytes,
            visibility, uploaded_by_kind, uploaded_by_id, notes,
            retention_class, exif_stripped, sniffed_mime, image_width, image_height, sha256)
         VALUES ('child',$1,$2,$3,$4,$5,$6,$7,'staff','registration',0,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [g.childId, spec.label, category,
         // The family's own filename is kept for the audit trail but NEVER used
         // to build a path: it is attacker-controlled text.
         String(req.file.originalname || '').slice(0, 255),
         full, chk.mime, chk.buffer.length,
         'Sent by the family with their registration form.',
         CD.classFor(category), chk.exifStripped, chk.mime, chk.width, chk.height, chk.sha256]);

      try {
        await db.query(
          `INSERT INTO person_document_audit(doc_id, action, actor_kind, actor_id, detail)
           VALUES ($1,'upload','parent',0,$2)`,
          [doc.id, `registration invite #${g.invite.id} · ${category}`]);
      } catch (e) { console.error('[onboard/photos] audit failed:', e.message); }

      // The allergy dead-end guard runs here too — a letter sent at registration
      // is the MOST likely one to be missed, because nobody has opened the
      // profile yet.
      await CD.ensureAllergyTask(db, g.childId, doc.id, category);

      res.status(201).json({ ok: true, category, retention_class: CD.classFor(category) });
    } catch (e) {
      console.error('[onboard/photos] store failed:', e.message);  // message only, never a field value
      res.status(500).json({ error: 'We could not save that file. Please try again, or email it to the nursery.' });
    }
  });
});

// ── STAFF form page ─────────────────────────────────────────────────────────────
router.get('/onboard/staff', pageLimiter, async (req, res) => {
  const inv = await gate(req, res, 'staff'); if (!inv) return;
  // b275 — a starter who lands here straight from the welcome email counts as
  // having opened it, same as the workbook page. markOpened is defined with the
  // b275 block below (function declaration — hoisted).
  if (inv.staff_id) markOpened(inv.id);
  res.type('html').send(page('Complete your onboarding', `${PAYROLL_CSS}
    <h1>Staff onboarding</h1>
    <p class="sub">Welcome! Please complete your details. Your role and login PIN will be set by the nursery once your details are reviewed.</p>
    <form id="f" autocomplete="on">
      <input type="hidden" id="token" value="${esc(req.query.token)}">
      <input type="text" class="hp" id="company" tabindex="-1" autocomplete="off" aria-hidden="true">
      <fieldset><legend>You</legend>
        <div class="row">
          <div><label class="req" for="first">First name</label><input id="first" required></div>
          <div><label class="req" for="last">Last name</label><input id="last" required></div>
        </div>
        <div class="row">
          <div><label for="pref">Preferred name</label><input id="pref"></div>
          <div><label for="dob">Date of birth</label><input id="dob" type="date"></div>
        </div>
        <div class="row">
          <div><label class="req" for="email">Email</label><input id="email" type="email" required></div>
          <div><label for="phone">Phone</label><input id="phone" type="tel" inputmode="tel"></div>
        </div>
      </fieldset>
      <fieldset><legend>Address</legend>
        <label for="a1">Address line 1</label><input id="a1">
        <div class="row">
          <div><label for="a2">Address line 2</label><input id="a2"></div>
          <div><label for="pc">Postcode</label><input id="pc"></div>
        </div>
      </fieldset>
      <fieldset><legend>Emergency contact</legend>
        <div class="row">
          <div><label for="ecn">Name</label><input id="ecn"></div>
          <div><label for="ecp">Phone</label><input id="ecp" type="tel" inputmode="tel"></div>
        </div>
      </fieldset>
      <fieldset><legend>Employment</legend>
        <div class="row">
          <div><label for="emp">Employment type</label>
            <select id="emp"><option value="">Select…</option><option>Full-time</option><option>Part-time</option><option>Bank / casual</option><option>Apprentice</option></select></div>
          <div><label for="hours">Contracted hours / week</label><input id="hours" type="number" step="0.5" min="0"></div>
        </div>
        <label for="cstart">Start date</label><input id="cstart" type="date">
      </fieldset>
      <fieldset><legend>Checks &amp; qualification</legend>
        <div class="row">
          <div><label for="dbs">DBS certificate number</label><input id="dbs"></div>
          <div><label for="qual">Highest qualification</label><input id="qual" placeholder="e.g. Level 3 Early Years"></div>
        </div>
      </fieldset>
      ${payrollFieldset()}
      <button class="btn" id="go" type="submit">Submit my details</button>
      <div class="err" id="err"></div>
    </form>
    <script>${FORM_JS('staff')}</script>
  `));
});

// The client submit script (shared, parameterised by type).
// b274 — `hasTerms` adds accept_terms to the child payload and requires it before
// submit. The server re-checks it regardless: a browser check is a courtesy, not
// the record.
function FORM_JS(type, hasTerms) {
  const val = 'function v(id){var e=document.getElementById(id);return e?(e.type==="checkbox"?e.checked:e.value):null;}'
    // b303 — a radio group has no single element to read.
    + 'function r(n){var e=document.querySelector(\'input[name="\'+n+\'"]:checked\');return e?e.value:null;}'
    // b303 — an UNTICKED box is "she did not say", not "she said no". The route
    // writes every field with COALESCE($n, col) so a blank never wipes what a
    // manager already typed, and a literal false would defeat that on this one
    // form the starter only ever gets to submit once. The columns default to
    // false, so null and false read identically downstream.
    + 'function cb(id){return v(id)===true?true:null;}';
  const collect = type === 'child'
    ? `var body={token:v('token'),company:v('company'),first_name:v('first'),last_name:v('last'),preferred_name:v('pref'),date_of_birth:v('dob'),start_date:v('start'),parent_1_name:v('p1n'),parent_1_phone:v('p1p'),parent_1_email:v('p1e'),parent_2_name:v('p2n'),parent_2_phone:v('p2p'),parent_2_email:v('p2e'),emergency_contact_1_name:v('e1n'),emergency_contact_1_phone:v('e1p'),emergency_contact_2_name:v('e2n'),emergency_contact_2_phone:v('e2p'),gp_name:v('gpn'),gp_phone:v('gpp'),allergies:v('alg'),dietary_requirements:v('diet'),medical_notes:v('med'),tfc_payment_reference:v('tfc'),photo_consent:v('photo'),media_consent:v('media'),accept_terms:v('tc')};`
    : `var body={token:v('token'),company:v('company'),first_name:v('first'),last_name:v('last'),preferred_name:v('pref'),date_of_birth:v('dob'),email:v('email'),phone:v('phone'),address_line1:v('a1'),address_line2:v('a2'),postcode:v('pc'),emergency_contact_name:v('ecn'),emergency_contact_phone:v('ecp'),employment_type:v('emp'),contracted_hours:v('hours'),contract_start:v('cstart'),dbs_number:v('dbs'),qualification:v('qual'),ni_number:v('ni'),p45_provided:cb('p45'),starter_declaration:r('dec'),student_loan_plan:v('sl'),postgrad_loan:cb('pgl')};`;
  return `${val}
document.getElementById('f').addEventListener('submit',function(ev){ev.preventDefault();
  var err=document.getElementById('err'),btn=document.getElementById('go');
  ${collect}
  if(!body.first_name||!body.last_name){err.textContent='Please enter first and last name.';err.style.display='block';return;}
  ${type === 'child' ? "if(!body.parent_1_email){err.textContent='A parent email is required.';err.style.display='block';return;}" : "if(!body.email){err.textContent='Your email is required.';err.style.display='block';return;}"}
  ${type === 'child' && hasTerms ? "if(!body.accept_terms){err.textContent='Please read and accept the Terms & Conditions to continue.';err.style.display='block';var tc=document.getElementById('tc');if(tc)tc.focus();return;}" : ''}
  err.style.display='none';btn.disabled=true;btn.textContent='Submitting…';
  fetch('/api/onboard/${type}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
   .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
   .then(function(x){ if(!x.ok){throw new Error((x.j&&x.j.error)||'Something went wrong.');}
     ${type === 'child' ? `
     /* b321 — the details are saved, so the child now exists and files have
        something to belong to. Go straight on to the photos rather than ending
        on a dead thank-you: a family that closes this tab has to be chased for
        the peg photo by hand, which is the job this build exists to remove.
        The link is theirs to come back to for 30 days. */
     if(x.j&&x.j.photos_url){ window.location.href=x.j.photos_url; return; }` : ''}
     document.querySelector('.card').innerHTML='<div class="ok"><div class="big">🕊️</div><h1>Thank you!</h1><p class="sub">Your details have been sent to Your Nursery. We\\'ll be in touch once they\\'ve been reviewed.</p></div>';
   })
   .catch(function(e){err.textContent=e.message;err.style.display='block';btn.disabled=false;btn.textContent='Try again';});
});
${type === 'child' ? TFC_JS : ''}
${type === 'staff' ? PAYROLL_JS : ''}`;
}

// b325 — the Tax-Free Childcare reference, checked as it is typed.
//
// It NEVER blocks the form. A registration is the wrong place to argue with a
// family about a reference HMRC gave them; the hint tells them what we expected,
// and the office sees the same note against the child at approval. Purely
// presentational — the route re-checks the value it is sent.
const TFC_JS = `
(function(){
  var f=document.getElementById('tfc'), h=document.getElementById('tfc-hint');
  if(!f||!h) return;
  var base=h.innerHTML;
  f.addEventListener('input',function(){
    f.value=f.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,9);
    if(!f.value){ h.innerHTML=base; h.style.color=''; return; }
    if(/^[A-Z]{4}[0-9]{5}$/.test(f.value)){
      h.innerHTML='That looks right \u2014 thank you.'; h.style.color='#15803d';
    } else {
      h.innerHTML='A Tax-Free Childcare reference is four letters then five digits, like AJON12345. '
        + 'You can still send the form \u2014 the office will check it with you.';
      h.style.color='#b45309';
    }
  });
})();`

// b303 — a P45 supersedes the employee statement, so ticking it fades the three
// statements out and clears whichever was chosen. Presentation only: the route
// does not require a declaration in any case, and it re-reads the P45 flag from
// the body rather than trusting that this ran.
// b303 — the read-back. Once her details are in, the workbook page shows her
// what she gave us, so she can see she is not being asked the same questions
// twice (and so that a mistyped NI number is visible to the one person who can
// tell it is wrong).
//
// SCOPED BY THE INVITE ROW, like everything else on this page: the staff id
// comes off the invite, never from the URL, so it can only ever be her own
// record. It is collapsed behind a <details> rather than printed open — this
// page is read on a phone, sometimes on a bus.
function payrollReadbackHtml(row) {
  if (!row) return '';
  const p = hmrc.describe(row);
  const any = p.ni_number || p.declaration || p.student_loan_plan || p.p45_provided || p.postgrad_loan;
  if (!any) return '';
  const line = (dt, dd) => dd ? `<dt>${esc(dt)}</dt><dd>${esc(dd)}</dd>` : '';
  return `<details class="pay-read">
    <summary>What you told us for payroll</summary>
    <dl>
      ${line('National Insurance number', p.ni_number)}
      ${p.p45_provided ? line('P45', 'You said you have one to bring in.') : ''}
      ${p.declaration ? line(`Your statement — ${p.declaration}`, p.declaration_summary) : ''}
      ${line('Student loan', p.student_loan_label)}
      ${p.postgrad_loan ? line('Postgraduate loan', 'Yes') : ''}
      <dt>Why we hold this</dt>
      <dd>${esc(hmrc.PURPOSE_LINE)} If any of it is wrong, tell your manager and they will correct it.</dd>
    </dl>
  </details>`;
}

const PAYROLL_JS = `
(function(){
  var p45=document.getElementById('p45'), blk=document.getElementById('dec-block');
  if(!p45||!blk) return;
  function sync(){
    blk.style.opacity = p45.checked ? '.45' : '';
    if(p45.checked){
      var c=blk.querySelector('input[name="dec"]:checked'); if(c) c.checked=false;
    }
  }
  p45.addEventListener('change', sync); sync();
})();`;

// ── 2026-09-18 — the payroll sheet goes to the office by itself ──────────────
// Toby: "the details get put onto the new starter checklist and sent to us as
// the PDF we can pass on to payroll". Fire-and-forget: a mail failure must never
// fail the starter's submission, and she has already seen "thank you" by the
// time this runs. The figures are in the ATTACHMENT — the body carries a name
// and nothing else (src/routes/hmrc-starter.js).
async function emailPayrollSheet(staffId) {
  try {
    const { rows } = await getPool().query(
      `SELECT id, first_name, last_name, preferred_name, date_of_birth, address_line1,
              address_line2, postcode, contract_start, employment_type, contracted_hours,
              ni_number, tax_code, starter_declaration, student_loan_plan, postgrad_loan,
              p45_provided
         FROM staff WHERE id = $1`, [staffId]);
    if (!rows.length) return;
    const r = rows[0];
    // Nothing to send if she answered none of it — the readiness check in
    // Finance is where a manager notices, not an empty sheet in an inbox.
    if (!r.ni_number && !r.starter_declaration && !r.student_loan_plan && r.p45_provided !== true) return;
    const { emailStarterSheet } = require('./hmrc-starter');
    await emailStarterSheet(r);
  } catch (e) {
    console.error('[onboard] payroll sheet email failed:', e.message);
  }
}

// ── notify managers (best-effort; minimal PII to Toby's private ops channel) ────
// login-20261023: through the one Telegram sender (src/lib/notifications.js), which carries the dev guard.
function notifyManagers(type, firstName) {
  const where = type === 'child' ? 'Children' : 'Staff';
  const text = `🕊️ New ${type} onboarding submission awaiting approval${firstName ? ` — ${firstName}` : ''}. Review in Roost → ${where}.`;
  require('../lib/notifications').sendTelegramNow({ text, parse_mode: null });
}

// Mark the invite used (single-use), record the created entity + a display summary.
async function markSubmitted(inviteId, entityId, summary) {
  await getPool().query(
    `UPDATE onboarding_invites
        SET status='submitted', submitted_at=now(), submitted_entity_id=$2, submitted_summary=$3
      WHERE id=$1`, [inviteId, entityId, summary]);
}

// ── POST /api/onboard/child ─────────────────────────────────────────────────────
router.post('/api/onboard/child', submitLimiter, async (req, res) => {
  const b = req.body || {};
  if (clean(b.company, 80)) return res.status(200).json({ ok: true }); // honeypot
  const inv = await loadInvite(b.token, 'child');
  if (!inv) return res.status(404).json({ error: 'This link is not valid.' });
  if (inv.status !== 'pending') return res.status(410).json({ error: 'This link has already been used or has expired.' });

  const first = clean(b.first_name, 120), last = clean(b.last_name, 120);
  if (!first || !last) return res.status(400).json({ error: 'First and last name are required.' });
  const p1email = clean(b.parent_1_email, 320);
  if (!p1email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p1email)) {
    return res.status(400).json({ error: 'A valid parent email is required.' });
  }

  // ── b274 — accept the terms BEFORE anything is created ──────────────────────
  // Order matters. The acceptance is the legal record; the child row and the
  // consumed invite are the recoverable parts. Writing the acceptance first means
  // a failure here leaves nothing behind and the invite still pending, so the
  // family can simply submit again. Doing it last would risk a registration that
  // succeeded with no record of what was agreed, which is the failure that
  // actually matters.
  //
  // The VERSION IS READ FROM THE DATABASE, never from the request body — the
  // same rule as POST /welcome/policies/api/sign. A client that could name its
  // own version could accept v1 of a document it was shown as v2.
  const terms = await loadTerms();
  if (terms && !truthy(b.accept_terms)) {
    return res.status(400).json({ error: 'Please read and accept the Terms & Conditions to continue.' });
  }
  try {
    const db = getPool();

    // b399 (2026-10-06) — if this invite's enquiry/waiting-list already has a
    // provisional ("enquiry mode") child, reuse that SAME row rather than
    // creating a second child — the home log and messages they built up while
    // enquiring carry straight over. Resolved here, before the insert/update
    // below decides which one to do.
    let _enquiryIdForLink = inv.enquiry_id || null;
    if (!_enquiryIdForLink && inv.waiting_list_id) {
      const { rows: wlRows0 } = await db.query(
        `SELECT enquiry_id FROM waiting_list WHERE id=$1`, [inv.waiting_list_id]);
      _enquiryIdForLink = wlRows0[0]?.enquiry_id || null;
    }
    let _provisionalChildId = null;
    if (_enquiryIdForLink) {
      const { rows: provRows } = await db.query(
        `SELECT id FROM children WHERE enquiry_id=$1 AND status='enquiry' LIMIT 1`, [_enquiryIdForLink]);
      _provisionalChildId = provRows[0]?.id || null;
    }

    if (terms) {
      await db.query(`
        INSERT INTO parent_policy_acknowledgments
          (policy_id, parent_email, child_id, policy_version, version_label, ip, user_agent, source, detail)
        VALUES ($1,$2,NULL,$3,$4,$5,$6,'enrolment',$7)
        ON CONFLICT (policy_id, parent_email, policy_version) DO NOTHING`,
        [terms.id, p1email.toLowerCase(), terms.version, terms.version_label,
         String(req.ip || '').slice(0, 45),
         String(req.headers['user-agent'] || '').slice(0, 1000),
         JSON.stringify({ title: terms.title, signed_label: terms.version_label })]);
    }
    // ── b325 — the Tax-Free Childcare reference ───────────────────────────────
    // Optional, and it NEVER blocks a registration. Three outcomes:
    //   right shape, letters agree  → stored, no note
    //   right shape, letters differ → stored, with the note (double-barrelled and
    //                                 changed surnames are real)
    //   wrong shape                 → NOT stored as a reference, but recorded
    //                                 verbatim in the note so the office can ask.
    // Dropping an unparseable value silently would lose the only thing the family
    // was asked to bring, and nobody would know to chase it.
    const tfcRaw = clean(b.tfc_payment_reference, 40);
    let tfcRef = null, tfcNote = null;
    if (tfcRaw) {
      const chk = PAYREF.checkTfcRef(tfcRaw, first, last);
      if (chk.ref) { tfcRef = chk.ref; tfcNote = chk.warning; }
      else tfcNote = `The family entered "${tfcRaw}" at registration, which is not the shape of a `
                   + 'Tax-Free Childcare reference (four letters, five digits). Please check it with them.';
    }
    const childFields = [first, last, clean(b.preferred_name, 120), cleanDate(b.date_of_birth), cleanDate(b.start_date),
       clean(b.parent_1_name, 200), p1email.toLowerCase(), clean(b.parent_1_phone, 50),
       clean(b.parent_2_name, 200), clean(b.parent_2_email, 320), clean(b.parent_2_phone, 50),
       clean(b.emergency_contact_1_name, 200), clean(b.emergency_contact_1_phone, 50),
       clean(b.emergency_contact_2_name, 200), clean(b.emergency_contact_2_phone, 50),
       clean(b.gp_name, 200), clean(b.gp_phone, 50), clean(b.allergies, 2000),
       clean(b.dietary_requirements, 2000), clean(b.medical_notes, 4000),
       truthy(b.photo_consent), truthy(b.media_consent), tfcRef, tfcNote];
    let childId;
    if (_provisionalChildId) {
      // b399 — reuse the provisional child: same row, so its home log and
      // messages carry over. Still 'pending' until a manager approves it.
      const { rows } = await db.query(
        `UPDATE children SET
           first_name=$1,last_name=$2,preferred_name=$3,date_of_birth=$4,start_date=$5,
           parent_1_name=$6,parent_1_email=$7,parent_1_phone=$8,
           parent_2_name=$9,parent_2_email=$10,parent_2_phone=$11,
           emergency_contact_1_name=$12,emergency_contact_1_phone=$13,
           emergency_contact_2_name=$14,emergency_contact_2_phone=$15,
           gp_name=$16,gp_phone=$17,allergies=$18,dietary_requirements=$19,medical_notes=$20,
           photo_consent=$21,media_consent=$22,
           tfc_payment_reference=$23,tfc_reference_warning=$24,
           tfc_reference_source=CASE WHEN $23::text IS NULL THEN NULL ELSE 'registration' END,
           tfc_reference_set_at=CASE WHEN $23::text IS NULL THEN NULL ELSE now() END,
           status='pending', updated_at=now()
         WHERE id=$25 RETURNING id`,
        [...childFields, _provisionalChildId]);
      childId = rows[0].id;
    } else {
      const { rows } = await db.query(
        `INSERT INTO children
           (first_name,last_name,preferred_name,date_of_birth,start_date,
            parent_1_name,parent_1_email,parent_1_phone,
            parent_2_name,parent_2_email,parent_2_phone,
            emergency_contact_1_name,emergency_contact_1_phone,
            emergency_contact_2_name,emergency_contact_2_phone,
            gp_name,gp_phone,allergies,dietary_requirements,medical_notes,
            photo_consent,media_consent,
            tfc_payment_reference,tfc_reference_warning,tfc_reference_source,tfc_reference_set_at,
            status,is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                 $23,$24,CASE WHEN $23::text IS NULL THEN NULL ELSE 'registration' END,
                 CASE WHEN $23::text IS NULL THEN NULL ELSE now() END,
                 'pending',false)
         RETURNING id`,
        childFields);
      childId = rows[0].id;
    }
    // b274 — now the child exists, point the acceptance at them. Scoping is
    // nullable by design (the ADULT accepts, once), so this only ever fills a
    // blank: an adult enrolling a second child keeps the acceptance they already
    // gave — ON CONFLICT DO NOTHING above left it alone — and it stays attached
    // to the first child rather than being re-pointed at the newer one.
    if (terms) {
      await db.query(
        `UPDATE parent_policy_acknowledgments SET child_id = $1
          WHERE policy_id = $2 AND parent_email = $3 AND policy_version = $4 AND child_id IS NULL`,
        [childId, terms.id, p1email.toLowerCase(), terms.version]).catch(() => {});
    }
    const summary = `${first} ${last}${cleanDate(b.date_of_birth) ? ' (DOB ' + cleanDate(b.date_of_birth) + ')' : ''}`;
    await markSubmitted(inv.id, childId, summary);
    // 2026-10-06 — a deposit paid while the family was on the waiting list goes onto the
    // new child's account now (LADN does not hold deposits).
    try { await require('../lib/deposits').adoptWaitlistDeposits(db, childId); } catch (_) {}

    // ── b398 — the registration link belongs to the family it was minted for ──
    // (gap 7: "registration isn't linked back to the enquiry or waiting-list
    // entry, so the waiting list can't tell the family has registered").
    // waiting_list_id/enquiry_id were stamped on the invite when the link was
    // created from a waiting-list row or pipeline card; a manually-typed link
    // (Children → Add child) carries neither, and this is simply a no-op then.
    // Never blocks the family's submission — they already have their "thank
    // you" page by the time any of this runs.
    try {
      let enquiryId = inv.enquiry_id || null;
      if (inv.waiting_list_id) {
        const { rows: wlRows } = await db.query(
          `SELECT enquiry_id FROM waiting_list WHERE id=$1`, [inv.waiting_list_id]);
        if (wlRows.length) {
          enquiryId = enquiryId || wlRows[0].enquiry_id;
          // NB: waiting_list has no updated_at column (unlike enquiries) — don't set one.
          await db.query(`UPDATE waiting_list SET status='placed' WHERE id=$1`, [inv.waiting_list_id]);
          // b532 — the child keeps the waiting-list EY number.
          await require('../lib/ey-number').adoptWaitlistNumber(db, childId, inv.waiting_list_id);
        }
      }
      if (enquiryId) {
        await db.query(`UPDATE children SET enquiry_id=$1 WHERE id=$2 AND enquiry_id IS NULL`, [enquiryId, childId]);
        // b424 — submitting the form alone no longer jumps the card to Registered:
        // "Registration forms & deposits received" (offer_accepted) means both halves
        // are in. If the deposit isn't settled yet this is a no-op and the card stays
        // there; whichever deposit route runs next (waitlist deposit mark, or
        // onboarding.js pay/credit) completes the move.
        await tryAdvanceToRegistered(db, enquiryId, { reason: 'registration form submitted' });
      }
    } catch (e) { console.error('[onboard/child] linking back to pipeline failed:', e.message); }

    notifyManagers('child', first);
    // b321 — the SAME single-use token, now pointing at a child that exists.
    // Returned rather than redirected so the page can decide; the server still
    // re-checks the token on every request to that page.
    res.status(201).json({ ok: true, photos_url: `/onboard/child/photos?token=${encodeURIComponent(b.token)}` });
  } catch (e) {
    console.error('[onboard/child] insert failed:', e.message); // message only — never field values
    res.status(500).json({ error: 'We could not save your details. Please try again or contact the nursery.' });
  }
});

// ── POST /api/onboard/staff ─────────────────────────────────────────────────────
router.post('/api/onboard/staff', submitLimiter, async (req, res) => {
  const b = req.body || {};
  if (clean(b.company, 80)) return res.status(200).json({ ok: true }); // honeypot
  const inv = await loadInvite(b.token, 'staff');
  if (!inv) return res.status(404).json({ error: 'This link is not valid.' });
  if (inv.status !== 'pending') return res.status(410).json({ error: 'This link has already been used or has expired.' });

  const first = clean(b.first_name, 120), last = clean(b.last_name, 120);
  if (!first || !last) return res.status(400).json({ error: 'First and last name are required.' });
  const email = clean(b.email, 320);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  const hours = b.contracted_hours != null && b.contracted_hours !== '' ? parseFloat(b.contracted_hours) : null;

  // ── b303 — the HMRC starter-checklist answers ──────────────────────────────
  // Validated AT THE ROUTE, not only by the CHECK constraint. A constraint
  // violation is a 500 and an opaque apology; a starter on a phone who has
  // mistyped one letter of her NI number deserves a sentence telling her which
  // letter. The constraint stays as the backstop it is meant to be.
  //
  // Every one of these is optional and blank is a valid answer to all of them.
  // A P45 supersedes the employee statement, so nothing here requires a
  // declaration in any circumstance — the readiness count in Finance is where an
  // employer notices it is missing, not a form that refuses to submit.
  const niR = hmrc.normaliseNi(b.ni_number);
  if (!niR.ok) return res.status(400).json({ error: niR.error, field: 'ni_number' });
  const decR = hmrc.normaliseDeclaration(b.starter_declaration);
  if (!decR.ok) return res.status(400).json({ error: decR.error, field: 'starter_declaration' });
  const slR = hmrc.normaliseStudentLoan(b.student_loan_plan);
  if (!slR.ok) return res.status(400).json({ error: slR.error, field: 'student_loan_plan' });
  // Booleans: true, or null for "not stated". Never false — see cb() in FORM_JS.
  const p45 = truthy(b.p45_provided) ? true : null;
  const pgLoan = truthy(b.postgrad_loan) ? true : null;

  try {
    const db = getPool();

    // ── b275 — a manager-initiated starter already HAS a staff row ────────────
    // POST /api/induction/starters creates the row (inactive) before the welcome
    // email goes out, and writes its id onto the invite. Inserting again here
    // would give the same person two records, one of which the induction
    // assignment points at and the other of which the manager sees. So when the
    // invite names a staff row, this fills that row in instead.
    //
    // It NEVER touches role, is_active, room_id or pin_hash: the role and the
    // account belong to the manager, and a PIN is set in person. Everything it
    // does write is a field the starter typed about themselves. COALESCE on the
    // incoming value keeps whatever the manager had already entered when the
    // starter leaves a box blank.
    if (inv.staff_id) {
      const { rows: upd } = await db.query(`
        UPDATE staff SET
          first_name              = COALESCE($2, first_name),
          last_name               = COALESCE($3, last_name),
          preferred_name          = COALESCE($4, preferred_name),
          email                   = COALESCE($5, email),
          phone                   = COALESCE($6, phone),
          date_of_birth           = COALESCE($7::date, date_of_birth),
          address_line1           = COALESCE($8, address_line1),
          address_line2           = COALESCE($9, address_line2),
          postcode                = COALESCE($10, postcode),
          emergency_contact_name  = COALESCE($11, emergency_contact_name),
          emergency_contact_phone = COALESCE($12, emergency_contact_phone),
          employment_type         = COALESCE($13, employment_type),
          contracted_hours        = COALESCE($14, contracted_hours),
          contract_start          = COALESCE($15::date, contract_start),
          dbs_number              = COALESCE($16, dbs_number),
          qualification           = COALESCE($17, qualification),
          -- b303: same COALESCE rule as every field above it. A box she left
          -- blank never wipes what a manager already typed.
          ni_number               = COALESCE($18, ni_number),
          starter_declaration     = COALESCE($19, starter_declaration),
          student_loan_plan       = COALESCE($20, student_loan_plan),
          postgrad_loan           = COALESCE($21::boolean, postgrad_loan),
          p45_provided            = COALESCE($22::boolean, p45_provided),
          updated_at              = NOW()
        WHERE id = $1 AND is_active = false
        RETURNING id`,
        [inv.staff_id, first, last, clean(b.preferred_name, 120), email.toLowerCase(), clean(b.phone, 50),
         cleanDate(b.date_of_birth), clean(b.address_line1, 200), clean(b.address_line2, 200), clean(b.postcode, 20),
         clean(b.emergency_contact_name, 200), clean(b.emergency_contact_phone, 50),
         clean(b.employment_type, 60), (hours != null && !isNaN(hours)) ? hours : null,
         cleanDate(b.contract_start), clean(b.dbs_number, 60), clean(b.qualification, 200),
         niR.value, decR.value, slR.value, pgLoan, p45]);
      if (!upd.length) {
        // Already activated by a manager while the form was open — their record is
        // live and this link has done its job. Nothing to write, nothing to fix.
        return res.status(410).json({ error: 'Your account has already been set up. Please speak to your manager.' });
      }
      await markSubmitted(inv.id, upd[0].id, `${first} ${last}`);
      notifyManagers('staff', first);
      emailPayrollSheet(upd[0].id);
      return res.status(201).json({ ok: true });
    }

    // role is deliberately fixed to the lowest real role; the manager sets the
    // real role at approval. is_active=false → cannot log in until approved.
    const { rows } = await db.query(
      `INSERT INTO staff
         (first_name,last_name,preferred_name,email,phone,role,
          date_of_birth,address_line1,address_line2,postcode,
          emergency_contact_name,emergency_contact_phone,
          employment_type,contracted_hours,contract_start,dbs_number,qualification,
          ni_number,starter_declaration,student_loan_plan,postgrad_loan,p45_provided,
          is_active,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'practitioner',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,COALESCE($20::boolean,false),COALESCE($21::boolean,false),
               false,NOW(),NOW())
       RETURNING id`,
      [first, last, clean(b.preferred_name, 120), email.toLowerCase(), clean(b.phone, 50),
       cleanDate(b.date_of_birth), clean(b.address_line1, 200), clean(b.address_line2, 200), clean(b.postcode, 20),
       clean(b.emergency_contact_name, 200), clean(b.emergency_contact_phone, 50),
       clean(b.employment_type, 60), (hours != null && !isNaN(hours)) ? hours : null,
       cleanDate(b.contract_start), clean(b.dbs_number, 60), clean(b.qualification, 200),
       niR.value, decR.value, slR.value, pgLoan, p45]);
    const staffId = rows[0].id;
    await markSubmitted(inv.id, staffId, `${first} ${last}`);
    notifyManagers('staff', first);
    emailPayrollSheet(staffId);
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('[onboard/staff] insert failed:', e.message);
    res.status(500).json({ error: 'We could not save your details. Please try again or contact the nursery.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// b275 — the new starter's own induction workbook (2026-09-04)
//
//   GET /onboard/induction?token=…   (and /starter/induction, the same handler)
//
// SERVED UNDER /onboard/ ON PURPOSE. The welcome email has to reach somebody who
// does not work here yet, and parents.example-nursery.co.uk sits behind
// Cloudflare Access — a brand-new starter cannot pass it. The public nursery
// site already proxies /onboard/* and /api/onboard/* same-origin to wren-ladn
// (nginx.conf, 2026-07-15), and prod's settings.onboard_public_host is
// example-nursery.co.uk, so a link under /onboard/ works on the day this
// deploys with no nginx change. /starter/induction is kept as an alias for
// direct-host access; it is NOT the address the email uses.
//
// A manager onboards a new starter by email (POST /api/induction/starters). The
// welcome email carries this link so the starter can read week 1 before day one,
// with no login and no PIN — a PIN is set by a manager in person, and this page
// says so rather than being a way round it.
//
// WHAT THE TOKEN OPENS, EXACTLY:
//   • the item titles and descriptions of THEIR OWN induction assignment
//   • their own first name, start date and their room leader's name
//   • their own details form (/onboard/staff?token=…, the same token)
// and nothing else. No child data, no other staff member, no EY portal. That is
// structural rather than a filter: this router is mounted before authentication
// and serves only these paths, and no authenticated route accepts an invite
// token as a credential — so the token cannot be presented to /api/children at
// all, with or without a Bearer prefix.
//
// The DETAILS FORM is single-use (the invite must still be 'pending'). THIS page
// stays readable while the invite is pending OR submitted, because a starter who
// has already sent their details in should still be able to read weeks 2–4 in
// their first fortnight. Once a manager approves them they have a real login, and
// the token stops working here too.
// ═══════════════════════════════════════════════════════════════════════════════

const READABLE_INVITE_STATES = ['pending', 'submitted'];

// Where the starter will eventually log in — resolved exactly as
// src/routes/induction.js starterUrls() resolves it, so the page and the email
// can never disagree about the address.
async function starterPortalUrl() {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM settings WHERE key='staff_portal_url' LIMIT 1");
    if (rows[0]?.value) return rows[0].value;
  } catch (_) { /* settings unavailable — fall through */ }
  if (process.env.EY_DOMAIN) return `https://${process.env.EY_DOMAIN}`;
  return null;
}

// Record that the starter actually opened their link. This is the difference on
// the manager's screen between "we emailed her" and "she's read it".
// Fire-and-forget: it must never block or fail the page.
function markOpened(inviteId) {
  getPool().query(
    'UPDATE onboarding_invites SET opened_at = COALESCE(opened_at, now()) WHERE id = $1',
    [inviteId]).catch(() => {});
}

const ITEM_KIND = {
  course: 'Online course',
  reading: 'Reading',
  task: 'With your room leader',
  form: 'Form to complete',
  policy_ack: 'Policy to sign',
  document: 'Document to bring',
};

// Scoped to this page and appended to the card, so the shared page() chrome above
// is untouched. Literal palette for the same reason the rest of this file uses
// one: these pages are standalone and load no Wren stylesheet.
const STARTER_CSS = `<style>
  .s-prog{background:#f1f5f9;border-radius:6px;height:9px;overflow:hidden;margin:16px 0 6px}
  .s-prog-fill{height:100%;background:linear-gradient(90deg,var(--blue),var(--brand));border-radius:6px}
  .s-progtxt{font-size:.8rem;color:var(--muted);margin:0 0 18px}
  .s-note{background:#fffaf3;border:1px solid #f3d9b8;border-left:3px solid var(--brand);
    border-radius:9px;padding:13px 15px;font-size:.86rem;line-height:1.6;color:#4b5563}
  .s-note p{margin:9px 0}.s-note p:first-child{margin-top:0}.s-note p:last-child{margin-bottom:0}
  .s-note b{color:var(--ink)}
  .s-btn{display:block;text-align:center;text-decoration:none;line-height:1.2}
  .s-hint{font-size:.78rem;color:var(--muted);text-align:center;margin:8px 0 0}
  .s-done{margin-top:20px;padding:12px 14px;border-radius:9px;background:#f0fdf4;
    border:1px solid #bbf7d0;color:#166534;font-size:.86rem;font-weight:600}
  .wk{margin-top:26px}
  .wk h2{font-size:.95rem;margin:0 0 10px;color:var(--ink);border-top:1px solid var(--line);padding-top:16px}
  .wk h2 span{display:block;font-size:.78rem;font-weight:500;color:var(--muted);margin-top:2px}
  .it{display:flex;gap:11px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #f3f4f6}
  .it:last-child{border-bottom:0}
  .tick{flex:0 0 20px;height:20px;margin-top:1px;border-radius:50%;border:1.5px solid var(--line);
    color:#fff;font-size:.72rem;line-height:18px;text-align:center;font-weight:800}
  .it.done .tick{background:#22c55e;border-color:#22c55e}
  .ittitle{font-size:.88rem;font-weight:600;color:var(--ink)}
  .itdesc{font-size:.8rem;color:var(--muted);margin-top:3px;line-height:1.5}
  .itkind{font-size:.7rem;color:var(--blue);font-weight:700;text-transform:uppercase;
    letter-spacing:.04em;margin-top:4px}
  .opt{font-size:.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
</style>`;

router.get(['/onboard/induction', '/starter/induction'], pageLimiter, async (req, res) => {
  const inv = await loadInvite(req.query.token, 'staff');
  if (!inv) return res.status(404).type('html').send(gonePage('invalid'));
  if (!READABLE_INVITE_STATES.includes(inv.status)) {
    return res.status(410).type('html').send(gonePage(inv.status));
  }
  // No pre-created staff row = a plain self-service invite from the 2026-07-15
  // flow, which has no workbook behind it. Point them at the form they were sent.
  if (!inv.staff_id || !inv.assignment_id) {
    return res.status(404).type('html').send(page('Induction not ready', `
      <h1>Your induction isn't set up yet</h1>
      <p class="sub">This link opens a staff details form rather than an induction workbook.</p>
      <p><a href="/onboard/staff?token=${esc(req.query.token)}">Go to my details form</a></p>`));
  }

  try {
    const db = getPool();
    // ONE query, scoped by the assignment id written on this invite AND the staff
    // id written on it. The starter's own row, and nothing adjacent to it.
    const { rows: aRows } = await db.query(`
      SELECT a.id, a.start_date, a.target_complete_date, a.status,
             s.first_name, s.preferred_name,
             -- b313: does this person have a Wren login yet? A manager sets the
             -- PIN with them in person on day one (the paragraph below promises
             -- exactly that), so a pin_hash is the honest signal that the same
             -- workbook is now reachable on the HR portal and the EY tablets.
             -- The hash itself is never selected, only whether one exists.
             (s.pin_hash IS NOT NULL) AS has_login,
             t.name AS template_name,
             rl.first_name AS leader_first, rl.last_name AS leader_last,
             rm.name AS room_name
        FROM induction_assignments a
        JOIN staff s ON s.id = a.staff_id
        LEFT JOIN induction_templates t ON t.id = a.template_id
        LEFT JOIN staff rl ON rl.id = a.room_leader_id
        LEFT JOIN rooms rm ON rm.id = s.room_id
       WHERE a.id = $1 AND a.staff_id = $2`, [inv.assignment_id, inv.staff_id]);
    if (!aRows.length) return res.status(404).type('html').send(gonePage('invalid'));
    const a = aRows[0];

    const { rows: items } = await db.query(`
      SELECT ti.week_number, ti.section, ti.title, ti.description, ti.item_type, ti.required,
             COALESCE(ip.status,'pending') AS status
        FROM induction_item_progress ip
        JOIN induction_template_items ti ON ti.id = ip.item_id
       WHERE ip.assignment_id = $1
       ORDER BY ti.week_number NULLS LAST, ti.sort_order, ti.id`, [a.id]);

    markOpened(inv.id);

    const weeks = [];
    for (const it of items) {
      const w = it.week_number == null ? 0 : it.week_number;
      let bucket = weeks.find(x => x.w === w);
      if (!bucket) { bucket = { w, section: it.section, items: [] }; weeks.push(bucket); }
      bucket.items.push(it);
    }
    weeks.sort((x, y) => x.w - y.w);

    const doneCount = items.filter(i => i.status === 'done' || i.status === 'signed_off').length;
    const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0;
    const leader = a.leader_first ? `${a.leader_first} ${a.leader_last}` : null;
    const name = a.preferred_name || a.first_name;
    const detailsDone = inv.status !== 'pending';
    const portal = await starterPortalUrl();

    // b288 — the documents this starter was sent, with where they've got to.
    // Tolerates a tenant that hasn't run the b288 migration: the workbook still
    // renders, just without the pack.
    let packHtml = '';
    try {
      const docs = await starterPack.activeDocuments(db);
      const statuses = await starterPack.packStatusForStaff(db, inv.staff_id);
      packHtml = packListHtml(docs, statuses, req.query.token);
    } catch (e) { console.error('[starter/induction] pack unavailable:', e.message); }

    // b303 — her own payroll answers, read back. Tolerates a tenant that has not
    // run the b303 migration: the workbook still renders, just without the block.
    let payrollHtml = '';
    if (detailsDone) {
      try {
        const { rows: pr } = await db.query(
          `SELECT ni_number, starter_declaration, student_loan_plan, postgrad_loan, p45_provided
             FROM staff WHERE id = $1`, [inv.staff_id]);
        payrollHtml = payrollReadbackHtml(pr[0]);
      } catch (e) { console.error('[starter/induction] payroll read-back unavailable:', e.message); }
    }

    const weeksHtml = weeks.map(bk => `
      <section class="wk">
        <h2>${bk.w ? 'Week ' + bk.w : 'Also'}${bk.section ? `<span>${esc(String(bk.section).replace(/^Week \d+ · /, ''))}</span>` : ''}</h2>
        ${bk.items.map(it => {
          const done = it.status === 'done' || it.status === 'signed_off';
          return `<div class="it${done ? ' done' : ''}">
            <div class="tick" aria-hidden="true">${done ? '&#10003;' : ''}</div>
            <div class="itbody">
              <div class="ittitle">${esc(it.title)}${it.required ? '' : ' <span class="opt">optional</span>'}</div>
              ${it.description ? `<div class="itdesc">${esc(it.description)}</div>` : ''}
              <div class="itkind">${esc(ITEM_KIND[it.item_type] || it.item_type || '')}</div>
            </div>
          </div>`;
        }).join('')}
      </section>`).join('');

    res.type('html').send(page('My induction', `${STARTER_CSS}${PAYROLL_CSS}
      <h1>Hello ${esc(name)} — welcome 🕊️</h1>
      <p class="sub">${esc(a.template_name || 'Your induction')}${a.room_name ? ' · ' + esc(a.room_name) : ''}${a.start_date ? ' · starting ' + esc(fmtDate(a.start_date)) : ''}</p>

      <div class="s-prog"><div class="s-prog-fill" style="width:${pct}%"></div></div>
      <p class="s-progtxt">${doneCount} of ${items.length} signed off so far${leader ? ` &middot; ${esc(leader)} is your room leader` : ''}</p>

      <div class="s-note">
        <p><b>You don't need to log in to read this.</b> Have a skim through week 1 before your
        first day — the building and fire exits, safeguarding, safe sleeping, and the policies
        you'll be asked to sign. Nothing here is a test, and nobody expects you to have done any
        of it yet.</p>
        ${a.has_login
          ? /* b313 — they have an account now, so this page stops being the only
               way in. The SAME workbook, the same rows: a tick in Wren shows
               here on the next load and vice versa. Said plainly, because the
               alternative is teaching people that Wren lives in their email —
               and this link expires and cannot be re-found. */
            `<p><b>You have a Wren login now — and this workbook is in there.</b> It is the same
        workbook, not a copy: tick something in Wren and it shows here, tick it here and it shows
        in Wren. ${portal
          ? `Open <a href="${esc(portal)}">${esc(portal)}</a> and go to <b>More &rarr; My Induction</b>`
          : `Go to <b>More &rarr; My Induction</b> on the staff portal`}, or find it on any of the
        room tablets. That is the better place to work through it — this link expires, and your
        login doesn't.</p>
        <p><b>We never email PINs.</b> If anyone emails or messages you one, it didn't come from
        us — tell a manager. That stays true now you have an account, not just before.</p>`
          : `<p><b>Your Wren login comes later, in person.</b> ${portal
          ? `You'll log in at <a href="${esc(portal)}">${esc(portal)}</a> with a numeric PIN`
          : `You'll log in with a numeric PIN`} that a manager sets with you on your first day.
        Once you have it, this same workbook is waiting for you under
        <b>More &rarr; My Induction</b> — on the HR portal or on any room tablet.
        <b>We never email PINs.</b> If anyone emails or messages you one, it didn't come from us —
        tell a manager.</p>`}
        <p><b>About the account you're about to be given.</b> Wren holds children's personal data —
        names, dates of birth, photographs, medical and dietary needs, safeguarding records and
        family contact details. Your account is a safeguarding-relevant account, and every action
        you take in it is logged against your name, including the records you open and read. That
        is normal and it protects everyone, children and staff alike. Please only look at what you
        need for your work, never share your login, and never take nursery data off site.</p>
      </div>

      ${detailsDone
        ? `<div class="s-done">&#10003; Thank you — your details are with us. A manager will finish setting your account up.</div>`
        : `<a class="btn s-btn" href="/onboard/staff?token=${esc(req.query.token)}">Fill in my details</a>
           <p class="s-hint">Address, emergency contact, DBS, qualification and your payroll details — the bits we need for your file.</p>`}

      ${payrollHtml}

      ${weeksHtml}

      ${packHtml}

      <p class="s-hint" style="margin-top:22px">This page is just for you — please don't forward the
      link. If you can't open something, or anything looks wrong, ask your manager.</p>
    `));
  } catch (e) {
    console.error('[starter/induction] failed:', e.message); // message only — never field values
    res.status(500).type('html').send(page('Something went wrong',
      `<h1>We couldn't load your induction</h1>
       <p class="sub">Please try again shortly, or contact the nursery.</p>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// b288 — THE DOCUMENT PACK (2026-09-08)
//
// Toby: "needs handbook etc sent. I have uploaded the inductions that I do."
//
// The welcome email links here, one page per document, on the same invite token
// as the workbook. Not attachments: a tokened page reads on a phone, survives a
// mailbox that strips .docx, and stops working when the invite expires.
//
// Same gate as everything else in this file: the token is looked up, the invite
// must still be readable, and the page is built from the staff id and assignment
// id written on the INVITE ROW — never from anything in the URL. A starter
// cannot point ?doc= or a query param at somebody else's record, because no
// record is addressed by the URL at all.
//
// The two inductions render straight out of induction_template_items, which is
// where the verbatim text from Toby's .docx lives. There is no second copy of a
// fire instruction anywhere in this codebase to drift out of step with it.
// ─────────────────────────────────────────────────────────────────────────────
const starterPack = require('../lib/starter-pack');

const PACK_CSS = `<style>
  .pk{margin-top:24px;border-top:1px solid var(--line);padding-top:16px}
  .pk h2{font-size:.95rem;margin:0 0 4px}
  .pk .pksub{font-size:.8rem;color:var(--muted);margin:0 0 12px}
  .pkdoc{display:block;text-decoration:none;color:inherit;border:1px solid var(--line);
    border-radius:10px;padding:12px 14px;margin-bottom:9px;background:#fff}
  .pkdoc:hover{border-color:var(--blue)}
  .pkt{font-weight:700;font-size:.9rem;color:var(--blue)}
  .pks{font-size:.8rem;color:var(--muted);margin-top:3px;line-height:1.5}
  .pkflag{display:inline-block;font-size:.66rem;font-weight:800;text-transform:uppercase;
    letter-spacing:.04em;padding:2px 8px;border-radius:9px;margin-top:6px;
    background:#fffaf3;color:#4b5563;border:1px solid #f3d9b8}
  .pkflag.done{background:#f0fdf4;color:#166534;border-color:#bbf7d0}
  .dh1{font-size:1.02rem;margin:26px 0 8px;padding-top:16px;border-top:1px solid var(--line)}
  .dh2{font-size:.86rem;margin:18px 0 6px;color:var(--ink);text-transform:none}
  .dbody{font-size:.88rem;line-height:1.62;color:#374151}
  .dbody p{margin:9px 0}
  .dbody ul.dl{margin:9px 0;padding-left:20px}
  .dbody ul.dl li{margin:6px 0}
  .ck{display:flex;gap:11px;align-items:flex-start;padding:11px 0;border-bottom:1px solid #f3f4f6}
  .ck:last-child{border-bottom:0}
  .ckbox{flex:0 0 20px;height:20px;margin-top:1px;border-radius:5px;border:1.5px solid var(--line);
    color:#fff;font-size:.72rem;line-height:18px;text-align:center;font-weight:800}
  .ck.done .ckbox{background:#22c55e;border-color:#22c55e}
  .ckt{font-size:.89rem;font-weight:600;color:var(--ink)}
  .ckd{font-size:.82rem;color:var(--muted);margin-top:4px;line-height:1.55}
  .ckd div{margin:2px 0}
  .ackbox{margin-top:22px;background:#fffaf3;border:1px solid #f3d9b8;border-left:3px solid var(--brand);
    border-radius:10px;padding:14px 16px}
  .ackbox p{margin:0 0 10px;font-size:.86rem;line-height:1.6;color:#4b5563}
  .backlink{display:inline-block;margin-top:20px;font-size:.84rem;color:var(--blue);text-decoration:none}
</style>`;

function packListHtml(docs, statuses, token) {
  if (!docs.length) return '';
  const byId = new Map((statuses || []).map(s => [s.document_id, s]));
  return `${PACK_CSS}<div class="pk">
    <h2>What we've sent you</h2>
    <p class="pksub">No login needed. These open on a phone, and the link is the one in your welcome email.</p>
    ${docs.map(d => {
      const st = byId.get(d.id);
      const done = st && (st.state === 'done' || String(st.state).startsWith('acknowledged'));
      const flag = d.requires_ack
        ? `<span class="pkflag${done ? ' done' : ''}">${done ? '&#10003; acknowledged' : 'needs your tick'}</span>`
        : (d.item_count ? `<span class="pkflag${done ? ' done' : ''}">${done ? '&#10003; done' : `${d.item_count} points · with a manager`}</span>` : '');
      // b303: always our own tokened URL, even for a document hosted elsewhere —
      // that page records the open and then redirects. Same rule as the emailed
      // links (src/lib/starter-pack.js documentLinks).
      const href = `/onboard/document?token=${encodeURIComponent(token)}&doc=${encodeURIComponent(d.slug)}`;
      const away = d.external_url
        ? `<span class="pkflag">opens GOV.UK</span>`
        : '';
      return `<a class="pkdoc" href="${esc(href)}"${d.external_url ? ' target="_blank" rel="noopener"' : ''}>
        <div class="pkt">${esc(d.title)}</div>
        ${d.summary ? `<div class="pks">${esc(d.summary)}</div>` : ''}
        ${flag}${away}
      </a>`;
    }).join('')}
  </div>`;
}

router.get('/onboard/document', pageLimiter, async (req, res) => {
  const token = req.query.token;
  const inv = await loadInvite(token, 'staff');
  if (!inv) return res.status(404).type('html').send(gonePage('invalid'));
  if (!READABLE_INVITE_STATES.includes(inv.status)) {
    return res.status(410).type('html').send(gonePage(inv.status));
  }
  if (!inv.staff_id) return res.status(404).type('html').send(gonePage('invalid'));

  try {
    const db = getPool();
    const doc = await starterPack.documentBySlug(db, req.query.doc);
    if (!doc || !doc.is_active) {
      return res.status(404).type('html').send(page('Not in your pack', `${PACK_CSS}
        <h1>We can't find that document</h1>
        <p class="sub">It may have been replaced since your welcome email went out.</p>
        <a class="backlink" href="/onboard/induction?token=${esc(token)}">&larr; Back to my induction</a>`));
    }
    // b303: record the open BEFORE the redirect. An external document (the HMRC
    // starter checklist) is still something we sent and she still opened it;
    // returning early meant the one pack row that leaves our domain was also the
    // one we could never tell had been read.
    markOpened(inv.id);
    if (doc.external_url) return res.redirect(302, doc.external_url);

    const statuses = await starterPack.packStatusForStaff(db, inv.staff_id);
    const st = statuses.find(s => s.document_id === doc.id);
    const done = st && (st.state === 'done' || String(st.state).startsWith('acknowledged'));

    let bodyHtml = '';
    if (doc.template_id) {
      // The setting's own checklist, verbatim. Read-only here: these are the
      // inductions a manager walks through with you in person, and the room
      // leader ticks them off in Wren afterwards.
      const items = await starterPack.templateItems(db, doc.template_id);
      const { rows: prog } = await db.query(`
        SELECT ip.item_id, ip.status
          FROM induction_item_progress ip
          JOIN induction_assignments a ON a.id = ip.assignment_id
         WHERE a.staff_id = $1 AND a.template_id = $2`, [inv.staff_id, doc.template_id]);
      const state = new Map(prog.map(p => [p.item_id, p.status]));
      bodyHtml = items.map(it => {
        const s = state.get(it.id);
        const isDone = s === 'done' || s === 'signed_off';
        const details = (it.description || '').split('\n').filter(Boolean);
        return `<div class="ck${isDone ? ' done' : ''}">
          <div class="ckbox" aria-hidden="true">${isDone ? '&#10003;' : ''}</div>
          <div>
            <div class="ckt">${esc(it.title)}</div>
            ${details.length ? `<div class="ckd">${details.map(d => `<div>${esc(d)}</div>`).join('')}</div>` : ''}
          </div>
        </div>`;
      }).join('');
    } else {
      // body_html is generated by scripts/b288-build-starter-pack.py from the
      // source .docx — our own markup, not user input.
      bodyHtml = `<div class="dbody">${await starterPack.documentBody(db, doc.id) || ''}</div>`;
    }

    const ackHtml = doc.requires_ack ? (done
      ? `<div class="s-done">&#10003; Thank you — you told us you'd read this${st && st.at ? ' on ' + esc(fmtDate(st.at)) : ''}.</div>`
      : `<div class="ackbox">
           <p><b>Have you read it?</b> Ticking this records that you've been given this document
           and read it. It isn't a test, and it doesn't sign anything away — your manager will go
           through the parts that matter with you.</p>
           <button class="btn" id="ackbtn" style="margin-top:0">I have read this</button>
           <div class="err" id="ackerr"></div>
         </div>
         <script>
         document.getElementById('ackbtn').addEventListener('click', async function () {
           var b = this; b.disabled = true; b.textContent = 'Saving…';
           try {
             var r = await fetch('/api/onboard/acknowledge', {
               method: 'POST', headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ token: ${JSON.stringify(String(token))}, doc: ${JSON.stringify(String(doc.slug))} })
             });
             var j = await r.json();
             if (!r.ok) throw new Error(j.error || 'Could not save');
             b.textContent = '\\u2713 Thank you';
           } catch (e) {
             b.disabled = false; b.textContent = 'I have read this';
             var el = document.getElementById('ackerr');
             el.style.display = 'block'; el.textContent = e.message;
           }
         });
         </script>`) : '';

    res.type('html').send(page(doc.title, `${PACK_CSS}
      <h1>${esc(doc.title)}</h1>
      <p class="sub">${esc(doc.summary || '')}</p>
      ${bodyHtml}
      ${ackHtml}
      <a class="backlink" href="/onboard/induction?token=${esc(token)}">&larr; Back to my induction</a>
    `));
  } catch (e) {
    console.error('[starter/document] failed:', e.message); // message only — never field values
    res.status(500).type('html').send(page('Something went wrong',
      `<h1>We couldn't load that document</h1>
       <p class="sub">Please try again shortly, or contact the nursery.</p>`));
  }
});

// POST /api/onboard/acknowledge — the starter ticking "I have read this".
//
// The narrowest write in this file. It can only ever set the ONE induction item
// a pack document names as its acknowledgement, on an assignment belonging to
// the staff id on the invite. It cannot reach another item, another starter, or
// downgrade a manager's sign-off. No new table: this is the same
// induction_item_progress row the room leader sees.
// Its own limiter rather than submitLimiter's 12: a pack can hold several
// documents that each want a tick, and a starter reading on a phone will retry.
// Still bounded, and still a single idempotent row whatever they press.
const ackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});
router.post('/api/onboard/acknowledge', ackLimiter, async (req, res) => {
  const inv = await loadInvite(req.body?.token, 'staff');
  if (!inv) return res.status(404).json({ error: 'This link is no longer valid.' });
  if (!READABLE_INVITE_STATES.includes(inv.status)) {
    return res.status(410).json({ error: 'This link is no longer valid.' });
  }
  if (!inv.staff_id) return res.status(409).json({ error: 'There is no staff record on this invite.' });
  try {
    const result = await starterPack.recordAck(getPool(), {
      slug: req.body?.doc,
      staffId: inv.staff_id,
      note: 'Read and acknowledged by the starter from their welcome link',
    });
    if (!result.ok) return res.status(400).json({ error: result.reason });
    markOpened(inv.id);
    res.json({ ok: true, acknowledged_at: result.at, document: result.document });
  } catch (e) {
    console.error('[starter/acknowledge] failed:', e.message); // message only — never field values
    res.status(500).json({ error: 'Could not save that just now. Please try again.' });
  }
});

module.exports = router;
