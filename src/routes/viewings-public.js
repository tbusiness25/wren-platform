'use strict';
// b336 — Viewings: the FAMILY'S side. A tokenised, no-login link the office
// sends (minted in Roost, POST /api/viewings/invites) where a waiting-list or
// enquiry family picks a time for their child's room. Their choice lands as
// 'requested' — the room still has to Confirm it (see src/routes/viewings.js).
//
// Mounted PUBLIC/pre-auth in server-unified.js, same shelf as
// onboarding-public.js and keepsake-public.js: an unguessable per-family token
// is the access control, not a login.
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { getPool } = require('../db/pool');
const VS = require('../lib/viewings-shared');

// 2026-10-20 (fix-feedback-voice): scoped to this router's own paths. Mounted at the app ROOT
// (server-unified.js, before the global express.json({limit:'20mb'})), an unscoped router.use(express.json)
// ran on EVERY request and, first parser wins, capped every JSON body in Wren at this limit — so
// every bug report with a screenshot (and any other JSON write over the cap) 413'd before auth.
router.use('/api/public', express.json({ limit: '16kb' }));

const pageLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

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
  .room-tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
  .room-tab{padding:8px 14px;border-radius:20px;border:1px solid var(--line);background:#fff;font-weight:700;font-size:.85rem;cursor:pointer;color:var(--muted)}
  .room-tab.active{background:var(--blue);border-color:var(--blue);color:#fff}
  .slot-list{display:grid;gap:8px}
  .slot{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fff}
  .slot b{font-size:.95rem}
  .slot span{font-size:.8rem;color:var(--muted)}
  .slot button{padding:8px 14px;border:0;border-radius:9px;background:linear-gradient(135deg,var(--blue),var(--brand));color:#fff;font-weight:800;cursor:pointer;font-size:.85rem}
  .slot button:disabled{opacity:.5;cursor:default}
  .empty{color:var(--muted);font-size:.88rem;padding:20px 0;text-align:center}
  .err{display:none;margin-top:12px;padding:10px 12px;border-radius:9px;background:#fef2f2;color:#b91c1c;font-size:.86rem}
  .ok{text-align:center;padding:20px 6px}
  .ok .big{font-size:2.6rem}
  .foot{text-align:center;color:var(--muted);font-size:.78rem;margin-top:18px}
</style></head><body><div class="wrap">
  <div class="brand"><span class="dot"></span> Your Nursery</div>
  <div class="card">${inner}</div>
  <div class="foot">Your Nursery · 123 Example Lane, AB1 2CD · This is a secure single-use link.</div>
</div></body></html>`;
}

function gonePage(why) {
  const msg = why === 'expired'
    ? 'This link has expired. Please contact the nursery for a new one.'
    : why === 'used'
      ? 'A viewing has already been booked with this link. If you need to change it, please contact the nursery.'
      : 'This link is not valid. Please check the link the nursery sent you, or get in touch.';
  return page('Link unavailable', `<h1>Link no longer available</h1><p class="sub">${esc(msg)}</p>`);
}

async function loadInvite(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token || '')) return null;
  const { rows } = await getPool().query(`SELECT * FROM viewing_invites WHERE token=$1`, [token]);
  if (!rows.length) return null;
  const inv = rows[0];
  if (inv.status === 'pending' && inv.expires_at && new Date(inv.expires_at) < new Date()) {
    getPool().query(`UPDATE viewing_invites SET status='expired' WHERE id=$1`, [inv.id]).catch(() => {});
    return { ...inv, status: 'expired' };
  }
  return inv;
}

// ── the picker page ──────────────────────────────────────────────────────────
router.get('/viewing/:token', pageLimiter, async (req, res) => {
  const inv = await loadInvite(req.params.token);
  if (!inv) return res.status(404).type('html').send(gonePage('invalid'));
  if (inv.status === 'expired') return res.status(410).type('html').send(gonePage('expired'));
  if (inv.status === 'used') return res.status(410).type('html').send(gonePage('used'));

  if (!inv.opened_at) {
    getPool().query(`UPDATE viewing_invites SET opened_at=now() WHERE id=$1`, [inv.id]).catch(() => {});
  }

  res.type('html').send(page('Book your viewing', `
    <h1>Book your viewing</h1>
    <p class="sub">Choose a time that works for you. The room team will confirm it, and you'll get an email once they have.</p>
    <div id="tabs" class="room-tabs"></div>
    <div id="slots" class="slot-list"><div class="empty">Loading times…</div></div>
    <div class="err" id="err"></div>
    <script>
    (function(){
      var token = ${JSON.stringify(req.params.token)};
      var knownRoom = ${inv.room_id ? JSON.stringify(inv.room_id) : 'null'};
      var currentRoom = knownRoom;
      var rooms = [];
      function fmtDate(d){ var dt=new Date(d+'T12:00:00'); return dt.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}); }
      function renderTabs(){
        var t=document.getElementById('tabs');
        if(rooms.length<2){ t.style.display='none'; return; }
        t.innerHTML='';
        rooms.forEach(function(r){
          var b=document.createElement('button');
          b.className='room-tab'+(r.id===currentRoom?' active':'');
          b.textContent=r.display_name||r.name;
          b.addEventListener('click',function(){ currentRoom=r.id; renderTabs(); loadSlots(); });
          t.appendChild(b);
        });
      }
      function loadSlots(){
        var box=document.getElementById('slots');
        box.innerHTML='<div class="empty">Loading times…</div>';
        var q = currentRoom ? ('?room_id='+currentRoom) : '';
        fetch('/api/public/viewing/'+encodeURIComponent(token)+'/slots'+q)
          .then(function(r){ return r.json(); })
          .then(function(j){
            if(!rooms.length && j.rooms){ rooms=j.rooms; if(!currentRoom && rooms[0]) currentRoom=rooms[0].id; renderTabs(); }
            var slots=j.slots||[];
            if(!slots.length){ box.innerHTML='<div class="empty">No open times in the next few weeks — please contact the nursery.</div>'; return; }
            box.innerHTML='';
            slots.forEach(function(s){
              var row=document.createElement('div'); row.className='slot';
              row.innerHTML='<div><b>'+fmtDate(s.date)+'</b><br><span>'+s.start_time+' – '+s.end_time+' · '+s.room_name+'</span></div>';
              var btn=document.createElement('button'); btn.textContent='Book this';
              btn.addEventListener('click',function(){ book(s, btn); });
              row.appendChild(btn);
              box.appendChild(row);
            });
          })
          .catch(function(){ box.innerHTML='<div class="empty">Could not load times — please try again.</div>'; });
      }
      function book(s, btn){
        btn.disabled=true; btn.textContent='Booking…';
        var err=document.getElementById('err'); err.style.display='none';
        fetch('/api/public/viewing/'+encodeURIComponent(token)+'/book',{
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ room_id: s.room_id, date: s.date, start_time: s.start_time })
        }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
          .then(function(x){
            if(!x.ok) throw new Error((x.j&&x.j.error)||'Could not book that time.');
            document.querySelector('.card').innerHTML='<div class="ok"><div class="big">🕊️</div><h1>Requested!</h1>'
              +'<p class="sub">We\\'ve asked '+esc(s.room_name)+' to confirm '+fmtDate(s.date)+' at '+s.start_time+'. '
              +'You will get an email once it\\'s confirmed.</p></div>';
          })
          .catch(function(e){ err.textContent=e.message; err.style.display='block'; btn.disabled=false; btn.textContent='Book this'; });
      }
      function esc(s){ return String(s==null?'':s); }
      loadSlots();
    })();
    </script>
  `));
});

// ── open slots for this family's room(s) ─────────────────────────────────────
router.get('/api/public/viewing/:token/slots', apiLimiter, async (req, res) => {
  const inv = await loadInvite(req.params.token);
  if (!inv) return res.status(404).json({ error: 'Invalid link' });
  if (inv.status !== 'pending') return res.status(410).json({ error: `Link is ${inv.status}` });
  try {
    const db = getPool();
    const { rows: allRooms } = await db.query(`SELECT id, name, display_name FROM rooms ORDER BY id`);
    const roomId = req.query.room_id ? parseInt(req.query.room_id, 10) : (inv.room_id || undefined);
    const slots = await VS.nextOpenSlots(db, { roomId, limit: 12 });
    res.json({ slots, rooms: allRooms, suggested_room_id: inv.room_id || null });
  } catch (e) {
    console.error('[viewing-public slots]', e.message);
    res.status(500).json({ error: 'Could not load times' });
  }
});

// ── the family's choice ──────────────────────────────────────────────────────
router.post('/api/public/viewing/:token/book', apiLimiter, async (req, res) => {
  const inv = await loadInvite(req.params.token);
  if (!inv) return res.status(404).json({ error: 'Invalid link' });
  if (inv.status !== 'pending') return res.status(410).json({ error: `Link is ${inv.status}` });

  const b = req.body || {};
  const roomId = parseInt(b.room_id, 10);
  const date = String(b.date || '');
  const startTime = String(b.start_time || '');
  if (!Number.isInteger(roomId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ error: 'room_id, date and start_time required' });
  }

  const db = getPool();
  try {
    const { rows: slotRows } = await db.query(
      `SELECT duration_minutes FROM viewing_slots WHERE room_id=$1 AND weekday=$2 AND start_time=$3 AND active=true`,
      [roomId, VS.isoWeekday(date), startTime]);
    if (!slotRows.length) return res.status(400).json({ error: 'That is not an open slot' });
    const endTime = VS.addMinutes(startTime, slotRows[0].duration_minutes);

    const { rows } = await db.query(
      `INSERT INTO viewings (room_id, slot_date, start_time, end_time, status, family_type, family_id, requested_via)
       VALUES ($1,$2,$3,$4,'requested',$5,$6,'family') RETURNING id`,
      [roomId, date, startTime, endTime, inv.family_type, inv.family_id]);
    const viewingId = rows[0].id;

    await db.query(`UPDATE viewing_invites SET status='used', used_viewing_id=$1 WHERE id=$2`, [viewingId, inv.id]);

    // b531 — a family booking their own time moves the card to Tour booked, the
    // same as the office booking it for them (viewings.js POST /).
    try {
      const { advanceEnquiry, resolveEnquiryId } = require('../lib/enquiry-stage');
      const enquiryId = await resolveEnquiryId(db, inv.family_type, inv.family_id);
      if (enquiryId) await advanceEnquiry(db, enquiryId, 'tour_booked', { reason: 'family booked a viewing' });
    } catch (e) { console.error('[viewing-public stage-advance]', e.message); }

    const { notifyAsync } = require('../services/notification-dispatcher');
    const { rows: roomStaff } = await db.query(`SELECT id FROM staff WHERE room_id=$1 AND is_active=true`, [roomId]);
    for (const s of roomStaff) {
      notifyAsync('viewing_booked', 'staff', s.id, '👋 A family booked a viewing',
        `${date} at ${startTime} · confirm it or say you can't do this one`,
        { relatedTable: 'viewings', relatedId: viewingId, link: '/ey/viewings' }).catch(() => {});
    }

    res.status(201).json({ ok: true, viewing_id: viewingId });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That time has just been taken — please pick another.' });
    console.error('[viewing-public book]', e.message);
    res.status(500).json({ error: 'Could not book that time. Please try again.' });
  }
});

module.exports = router;
