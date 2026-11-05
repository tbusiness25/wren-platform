'use strict';
// ===========================================================================
// WEEKLY REGISTER — b194 (2026-08-19), additive.
//
// The printable weekly register in the EyWorks shape Toby works from: room heading, one row
// per child, a column per weekday carrying the session and its times, closed days greyed
// out, and a footer of Total Children / Employee Required / Employee Scheduled.
//
//   GET /api/register/week?room_id=&week_start=   → JSON (the same numbers the PDF prints)
//   GET /api/register/pdf?room_id=&week_start=    → A4 landscape PDF
//
// Mounted once in editions/ladn/server-unified.js, so it serves BOTH Roost (admin host) and
// EY (learning host) — the portals are one Express process dispatching on hostname.
//
// SOURCES (all read-only, all reused — nothing restated here):
//   ladn.child_bookings   the §55 booked-day register (whole-day: mon..fri booleans)
//   src/lib/closures      bank holidays + settings.closure_dates → a closed day is 0
//                         children and 0 required staff, which is the whole point of b194
//   services/ratio-engine getRatios() / ageBandOn() / requiredStaff() — the SAME maths the
//                         rota and the absence gatekeeper use, so the footer can never
//                         disagree with them
//   lib/offratio          shiftsForDay() for Employee Scheduled (rota_shifts, absences and
//                         unclaimed open shifts already excluded)
//
// PDF stack: pdfkit, exactly as src/routes/rota.js week/:date/payroll.pdf does. No new PDF
// dependency — the headless-Chromium path (ladn-ready/render-report-pdf.js) is for offline
// report rendering, not for a request handler.
// ===========================================================================
const express = require('express');
const router = express.Router();
const PDFDoc = require('pdfkit');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const ratioEngine = require('../services/ratio-engine');
const offratio = require('../lib/offratio');
const closures = require('../lib/closures');

router.use(authenticate);
// Operational document: any signed-in staff member needs it. Parents never do — and the
// parents host is denied the 'register' prefix in server-unified.js as well.
router.use((req, res, next) => {
  if (!req.user || req.user.role === 'parent') return res.status(403).json({ error: 'Staff access required' });
  next();
});

const DOWS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const DAY_LABEL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday' };

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function mondayOf(dateStr) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return ymd(d); }
const hhmm = mins => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// The operating window is offratio's, so the register, the ratio check and the rota all
// describe the same 8am–6pm day rather than three independently hard-coded ones.
const OPEN_FROM = hhmm(offratio.DAY_START_MIN);
const OPEN_TO = hhmm(offratio.DAY_END_MIN);

/** Session label. settings.occupancy_child_sessions is 'full_day' at LADN; whole-day
 *  bookings are all child_bookings can express, so anything else still prints as a day. */
async function sessionLabel(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='occupancy_child_sessions'`);
    const v = rows.length ? String(rows[0].value || '') : '';
    if (v && v !== 'full_day') return v.replace(/_/g, ' ');
  } catch (e) { /* default below */ }
  return 'Day/FT';
}

async function buildWeek(db, roomId, weekStart) {
  const wk = mondayOf(weekStart);
  const dates = DOWS.map((_, i) => addDays(wk, i));
  const weekEnd = dates[4];

  const { rows: roomRows } = await db.query(
    `SELECT id, name, capacity, COALESCE(legal_capacity, capacity) AS legal_capacity
       FROM rooms ${roomId ? 'WHERE id = $1' : ''} ORDER BY min_age_months, id`,
    roomId ? [roomId] : []);
  if (!roomRows.length) return null;

  const [closedMap, ratios, label] = await Promise.all([
    closures.loadClosures(db, wk, weekEnd),
    ratioEngine.getRatios(db),
    sessionLabel(db),
  ]);

  // Booked children whose booking overlaps this week at all. The per-day booleans decide
  // which columns they actually appear in.
  // 2026-10-28: + the details the EY weekly register shows (EyLog's Weekly Register Report:
  // DOB, start date, age dot, allergy/dietary flags), the booking's times (half days) and the
  // child's own start/leave dates; the room falls back to the child's room like occupancy.js.
  const { rows: kids } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.date_of_birth::text AS dob,
           c.start_date::text AS c_start, c.leave_date::text AS c_leave,
           (NULLIF(btrim(COALESCE(c.allergies,'')), '') IS NOT NULL AND lower(btrim(c.allergies)) NOT IN ('none','n/a','no','nil','-')) AS allergy,
           (NULLIF(btrim(COALESCE(c.dietary_requirements,'')), '') IS NOT NULL AND lower(btrim(c.dietary_requirements)) NOT IN ('none','n/a','no','nil','-')) AS diet,
           COALESCE(b.room_id, c.room_id) AS room_id, b.mon, b.tue, b.wed, b.thu, b.fri,
           b.start_date::text AS b_start, b.end_date::text AS b_end,
           b.start_time::text AS t_from, b.finish_time::text AS t_to,
           COALESCE(b.source, '') AS source
      FROM child_bookings b
      JOIN children c ON c.id = b.child_id
     WHERE b.is_active = true
       AND COALESCE(c.is_active, true) = true
       AND COALESCE(c.is_demo, false) = false
       AND COALESCE(b.room_id, c.room_id) = ANY($1::int[])
       AND b.start_date <= $3::date
       AND COALESCE(b.end_date, DATE '2100-01-01') >= $2::date
       AND (c.leave_date IS NULL OR c.leave_date >= $2::date)
     ORDER BY c.last_name, c.first_name`,
    [roomRows.map(r => r.id), wk, weekEnd]);

  // 2026-10-28 (Toby: "show any children planning to be on holiday or any parents who've
  // reported an absence"): what the family told us (parents app) or the office booked.
  const { rows: offRows } = await db.query(`
    SELECT child_id, start_date::text AS s, COALESCE(end_date, start_date)::text AS e,
           lower(COALESCE(absence_type, 'absence')) AS kind
      FROM parent_reported_absences
     WHERE start_date <= $2::date AND COALESCE(end_date, start_date) >= $1::date
       AND lower(COALESCE(status, '')) NOT IN ('rejected', 'cancelled', 'declined')
    UNION ALL
    SELECT child_id, date::text, date::text, 'holiday' FROM child_holidays WHERE date BETWEEN $1::date AND $2::date`,
    [wk, weekEnd]).catch(() => ({ rows: [] }));
  const offFor = (cid, date) => {
    const o = offRows.find(x => Number(x.child_id) === Number(cid) && x.s <= date && x.e >= date);
    if (!o) return null;
    return /sick|ill/.test(o.kind) ? 'sick' : /holiday/.test(o.kind) ? 'holiday' : 'absent';
  };
  const bookedOn = (k, date, key) => !!k[key] && date >= k.b_start && (!k.b_end || date <= k.b_end)
    && (!k.c_start || date >= k.c_start) && (!k.c_leave || date <= k.c_leave);

  // Rota, once per date, reused for every room in the response.
  const shiftsByDate = {};
  for (const d of dates) shiftsByDate[d] = closedMap.has(d) ? [] : await offratio.shiftsForDay(db, d);

  const rooms = [];
  for (const room of roomRows) {
    // The query fetches every requested room in one go, so split it per room here —
    // without room_id in the row, an all-rooms request would print every child in every room.
    const roomKids = kids.filter(k => Number(k.room_id) === Number(room.id));
    const children = [];
    const perDay = {};

    for (let i = 0; i < 5; i++) {
      const date = dates[i], key = DOWS[i];
      const closure = closedMap.get(date) || null;
      const booked = closure ? [] : roomKids.filter(k => bookedOn(k, date, key));
      // Children reported off don't need staff — the totals count who is actually coming.
      const present = booked.filter(k => !offFor(k.id, date));
      const bands = { under2: 0, two: 0, threePlus: 0 };
      for (const k of present) bands[k.dob ? ratioEngine.ageBandOn(k.dob, date) : 'under2']++;
      const required = closure ? 0 : ratioEngine.requiredStaff(bands, ratios);
      const shifts = (shiftsByDate[date] || []).filter(s =>
        s.counts_on_ratio && (s.room_id == null || Number(s.room_id) === Number(room.id)));
      perDay[key] = {
        date, label: DAY_LABEL[key], closed: !!closure, closure,
        total_children: present.length, bands,
        booked_children: booked.length, off_children: booked.length - present.length,
        employee_required: required,
        employee_scheduled: closure ? 0 : shifts.length,
        session: closure ? null : label, from: closure ? null : OPEN_FROM, to: closure ? null : OPEN_TO,
      };
    }

    for (const k of roomKids) {
      const days = {};
      for (let i = 0; i < 5; i++) {
        const date = dates[i], key = DOWS[i];
        const closure = closedMap.get(date) || null;
        const on = bookedOn(k, date, key);
        // Half days: a booking ending by 13:00 is AM only; one starting at 12:00 or later is PM only.
        const am = !(k.t_from && k.t_from >= '12:00'), pm = !(k.t_to && k.t_to <= '13:00');
        days[key] = closure ? { closed: true, closure }
          : on ? { booked: true, session: label, from: OPEN_FROM, to: OPEN_TO, am, pm, off: offFor(k.id, date) }
            : { booked: false };
      }
      const band = !k.dob ? null : (() => {
        const b = new Date(k.dob + 'T12:00:00'), d = new Date(wk + 'T12:00:00');
        const months = (d.getFullYear() - b.getFullYear()) * 12 + (d.getMonth() - b.getMonth()) - (d.getDate() < b.getDate() ? 1 : 0);
        return months < 12 ? '0-1' : months < 24 ? '1-2' : months < 36 ? '2-3' : '3+';
      })();
      children.push({
        child_id: k.id,
        name: [k.last_name, k.first_name].filter(Boolean).join(', '),
        display_name: [(k.preferred_name || k.first_name), k.last_name].filter(Boolean).join(' '),
        dob: k.dob, start_date: k.c_start, age_band: band, allergy: !!k.allergy, diet: !!k.diet,
        source: k.source, days,
      });
    }

    rooms.push({
      room_id: room.id, room: room.name,
      capacity: Number(room.capacity), legal_capacity: Number(room.legal_capacity),
      children, per_day: perDay,
    });
  }

  return {
    week_start: wk, week_end: weekEnd, dates,
    ratios,
    closures: Object.fromEntries(closedMap),
    rooms,
    note: 'Booked days come from the child_bookings register. Employee Required uses the '
        + 'configured ratios; Employee Scheduled counts ratio-countable rota shifts. Bank '
        + 'holidays and settings.closure_dates print as CLOSED with 0 children and 0 required.',
  };
}

// ── GET /week — JSON ────────────────────────────────────────────────────────
router.get('/week', async (req, res) => {
  try {
    const week = isDate(req.query.week_start) ? req.query.week_start : ymd(new Date());
    const roomId = req.query.room_id ? parseInt(req.query.room_id, 10) : null;
    if (req.query.room_id && !Number.isInteger(roomId)) return res.status(400).json({ error: 'room_id must be an integer' });
    const out = await buildWeek(getPool(), roomId, week);
    if (!out) return res.status(404).json({ error: 'room not found' });
    res.json(out);
  } catch (e) { console.error('[register/week]', e); res.status(500).json({ error: e.message }); }
});

// ── GET /pdf — printable weekly register ────────────────────────────────────
router.get('/pdf', async (req, res) => {
  try {
    const week = isDate(req.query.week_start) ? req.query.week_start : ymd(new Date());
    const roomId = req.query.room_id ? parseInt(req.query.room_id, 10) : null;
    if (req.query.room_id && !Number.isInteger(roomId)) return res.status(400).json({ error: 'room_id must be an integer' });
    const data = await buildWeek(getPool(), roomId, week);
    if (!data) return res.status(404).json({ error: 'room not found' });

    const M = 34;
    const doc = new PDFDoc({ size: 'A4', layout: 'landscape', margins: { top: M, bottom: M, left: M, right: M } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    const pageW = doc.page.width - M * 2;
    const wName = 168;
    const wDay = Math.floor((pageW - wName) / 5);
    const widths = [wName, wDay, wDay, wDay, wDay, wDay];
    const tableW = widths.reduce((a, b) => a + b, 0);
    const dayX = i => M + wName + wDay * i;

    const humanDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

    for (let ri = 0; ri < data.rooms.length; ri++) {
      const room = data.rooms[ri];
      if (ri) doc.addPage({ layout: 'landscape', margins: { top: M, bottom: M, left: M, right: M } });

      doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a')
        .text(`${room.room} — Weekly Register`, M, M);
      doc.font('Helvetica').fontSize(9.5).fillColor('#475569')
        .text(`Week commencing ${humanDate(data.week_start)} ${new Date(data.week_start + 'T00:00:00Z').getUTCFullYear()}`
            + `   ·   capacity ${room.capacity}`
            + `   ·   ratios ${data.ratios.under2}/${data.ratios.two}/${data.ratios.threePlus} (under 2 / two / three+)`
            + `   ·   generated ${ymd(new Date())}`);
      let y = doc.y + 8;

      // Grey the closed columns first so every later cell paints over the band.
      for (let i = 0; i < 5; i++) {
        if (!room.per_day[DOWS[i]].closed) continue;
        doc.save().rect(dayX(i), y, wDay, 999).fill('#e9edf2').restore();
      }

      const row = (cells, opts = {}) => {
        const h = opts.h || 20;
        if (opts.fill) { doc.save().rect(M, y, tableW, h).fill(opts.fill).restore(); }
        let x = M;
        cells.forEach((c, i) => {
          const txt = Array.isArray(c) ? c : [c, null];
          doc.font(opts.bold || i === 0 && opts.boldFirst ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(opts.size || 9).fillColor(opts.colour || '#1e293b')
            .text(String(txt[0] == null ? '' : txt[0]), x + 4, y + 4,
              { width: widths[i] - 8, align: i === 0 ? 'left' : 'center', lineBreak: false });
          if (txt[1]) {
            doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
              .text(String(txt[1]), x + 4, y + 12, { width: widths[i] - 8, align: 'center', lineBreak: false });
          }
          x += widths[i];
        });
        y += h;
        doc.moveTo(M, y).lineTo(M + tableW, y).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
      };

      row(['Child', ...DOWS.map(k => [room.per_day[k].label, humanDate(room.per_day[k].date)])],
        { bold: true, fill: '#f1f5f9', colour: '#0f172a', h: 24, size: 9 });

      if (!room.children.length) {
        row(['No booked children this week', '', '', '', '', ''], { colour: '#94a3b8' });
      }
      for (const c of room.children) {
        if (y > doc.page.height - M - 90) {
          doc.addPage({ layout: 'landscape', margins: { top: M, bottom: M, left: M, right: M } });
          y = M;
          for (let i = 0; i < 5; i++) {
            if (room.per_day[DOWS[i]].closed) { doc.save().rect(dayX(i), y, wDay, 999).fill('#e9edf2').restore(); }
          }
          row(['Child', ...DOWS.map(k => [room.per_day[k].label, humanDate(room.per_day[k].date)])],
            { bold: true, fill: '#f1f5f9', colour: '#0f172a', h: 24, size: 9 });
        }
        row([c.name, ...DOWS.map(k => {
          const d = c.days[k];
          if (d.closed) return ['—', null];
          return d.booked ? [d.session, `${d.from}–${d.to}`] : ['', null];
        })], { h: 21 });
      }

      y += 6;
      row(['Total Children', ...DOWS.map(k => room.per_day[k].closed ? 'CLOSED' : room.per_day[k].total_children)],
        { bold: true, fill: '#f8fafc', colour: '#0f172a' });
      row(['Employee Required', ...DOWS.map(k => room.per_day[k].closed ? '0' : room.per_day[k].employee_required)],
        { bold: true, colour: '#0f172a' });
      row(['Employee Scheduled', ...DOWS.map(k => {
        const d = room.per_day[k];
        if (d.closed) return '0';
        // Spelled out, not a warning glyph: pdfkit's built-in Helvetica is WinAnsi-encoded
        // and renders emoji/symbols as mojibake (see src/lib/owner-digest-pdf.js).
        return `${d.employee_scheduled}${d.employee_scheduled < d.employee_required ? ' (short)' : ''}`;
      })], { bold: true, colour: '#0f172a' });

      const closedNotes = DOWS.filter(k => room.per_day[k].closed)
        .map(k => `${room.per_day[k].label} ${humanDate(room.per_day[k].date)} — ${room.per_day[k].closure}`);
      doc.font('Helvetica').fontSize(7.5).fillColor('#94a3b8')
        .text((closedNotes.length ? 'Closed: ' + closedNotes.join(' · ') + '.  ' : '')
            + 'Booked days from the child_bookings register. Employee Required from the configured ratios by age band; '
            + 'Employee Scheduled counts ratio-countable rota shifts (absences and unclaimed open shifts excluded). '
            + 'Closed days come from bank_holidays + settings.closure_dates.',
          M, y + 8, { width: tableW });
    }

    doc.end();
    const buf = await done;
    const roomTag = data.rooms.length === 1 ? data.rooms[0].room.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'all-rooms';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="register-${roomTag}-${data.week_start}.pdf"`,
      'Content-Length': buf.length,
    });
    res.send(buf);
  } catch (e) {
    console.error('[register/pdf]', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
