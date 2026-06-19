'use strict';
const fs   = require('fs');
const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────

const LOGO_PATH = '/app/public/little-angels-logo.png';
const PAGE_W    = 595.28;
const PAGE_H    = 841.89;
const MARGIN    = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;
const HEADER_H  = 88;

const C_NAVY   = '#0f172a';
const C_BLUE   = '#4a9abf';
const C_ORANGE = '#e07820';
const C_TEXT   = '#1e293b';
const C_MUTED  = '#64748b';
const C_BORDER = '#e2e8f0';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safe(s) { return s == null ? '' : String(s); }

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return safe(d);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return safe(d);
  return dt.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function titleCase(s) {
  return safe(s).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function parseJSON(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ─── Space guard — add a new page if we're running low ───────────────────────

function needSpace(doc, height) {
  if (doc.y + height > PAGE_H - MARGIN - 10) {
    doc.addPage();
  }
}

// ─── Branded header ───────────────────────────────────────────────────────────
// Draws once per page (first page).  Positions cursor at HEADER_H + 18.

function drawHeader(doc, subtitle) {
  // Navy background strip
  doc.save().rect(0, 0, PAGE_W, HEADER_H).fill(C_NAVY).restore();

  // Logo — absolute, does not advance doc.y
  let textX = MARGIN;
  const logoSize = 58;
  if (fs.existsSync(LOGO_PATH)) {
    try {
      doc.image(LOGO_PATH, MARGIN, (HEADER_H - logoSize) / 2, {
        width: logoSize, height: logoSize
      });
      textX = MARGIN + logoSize + 14;
    } catch (_) {}
  }

  // Nursery name (two colours, same line) — explicit position
  doc.fillColor(C_BLUE).font('Helvetica-Bold').fontSize(16)
     .text('Your Nursery', textX, 20, { continued: true })
     .fillColor(C_ORANGE)
     .text(' Day Nursery', { lineBreak: false });

  // Address sub-line — position at y=44 inside header
  doc.fillColor('#94a3b8').font('Helvetica').fontSize(8)
     .text('123 Example Lane, Your Town, AB1 2CD  ·  01234 567890  ·  Mon–Fri 8am–6pm',
           textX, 43, { width: PAGE_W - textX - MARGIN });

  // Generated timestamp — right-aligned inside header
  doc.fillColor('#64748b').font('Helvetica').fontSize(7)
     .text(`Generated: ${fmtDateTime(new Date())}`,
           MARGIN, HEADER_H - 16, { width: CONTENT_W, align: 'right' });

  // Cursor below header
  doc.y = HEADER_H + 18;

  // Report subtitle
  if (subtitle) {
    doc.fillColor(C_TEXT).font('Helvetica-Bold').fontSize(13)
       .text(subtitle, MARGIN, doc.y, { width: CONTENT_W });
    const rulerY = doc.y + 2;
    doc.save().moveTo(MARGIN, rulerY).lineTo(MARGIN + 44, rulerY)
       .lineWidth(3).strokeColor(C_ORANGE).stroke().restore();
    doc.y = rulerY + 14;
  }
}

// ─── Footer rule on current page ─────────────────────────────────────────────

function drawFooter(doc) {
  const fy = PAGE_H - MARGIN - 18;
  doc.save()
     .moveTo(MARGIN, fy).lineTo(MARGIN + CONTENT_W, fy)
     .lineWidth(0.5).strokeColor(C_BORDER).stroke()
     .restore();
  doc.fillColor(C_MUTED).font('Helvetica').fontSize(7)
     .text(
       'Your Nursery  ·  123 Example Lane, Your Town, AB1 2CD  ·  Established 1990',
       MARGIN, fy + 6, { width: CONTENT_W, align: 'center' }
     );
}

// ─── Section divider ─────────────────────────────────────────────────────────

function section(doc, title) {
  needSpace(doc, 40);
  doc.y += 10;
  doc.fillColor(C_BLUE).font('Helvetica-Bold').fontSize(7.5)
     .text(title.toUpperCase(), MARGIN, doc.y, { width: CONTENT_W, characterSpacing: 0.8 });
  doc.y += 3;
  doc.save()
     .moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y)
     .lineWidth(0.5).strokeColor(C_BORDER).stroke()
     .restore();
  doc.y += 8;
}

// ─── Field row: label on left, value on right ─────────────────────────────────

function field(doc, label, value) {
  if (value === null || value === undefined || value === '') return;
  const str = safe(value);
  if (!str.trim()) return;

  needSpace(doc, 22);
  const lw = 135;
  const vw = CONTENT_W - lw - 8;
  const startY = doc.y;

  doc.fillColor(C_MUTED).font('Helvetica-Bold').fontSize(8)
     .text(label, MARGIN, startY, { width: lw, lineBreak: false });

  doc.fillColor(C_TEXT).font('Helvetica').fontSize(8.5)
     .text(str, MARGIN + lw + 8, startY, { width: vw });

  // Advance to after the value (which may be taller than the label)
  doc.y = Math.max(doc.y, startY + 14) + 3;
}

// ─── Long text block ─────────────────────────────────────────────────────────

function textBlock(doc, label, value) {
  if (!value || !safe(value).trim()) return;
  section(doc, label);
  needSpace(doc, 30);
  doc.fillColor(C_TEXT).font('Helvetica').fontSize(9)
     .text(safe(value).trim(), MARGIN, doc.y, { width: CONTENT_W, lineGap: 2 });
  doc.y += 12;
}

// ─── Tag list ────────────────────────────────────────────────────────────────

function tagList(doc, label, items) {
  if (!items || !items.length) return;
  section(doc, label);
  const joined = Array.isArray(items) ? items.join('  ·  ') : safe(items);
  doc.fillColor(C_TEXT).font('Helvetica').fontSize(9)
     .text(joined, MARGIN, doc.y, { width: CONTENT_W });
  doc.y += 12;
}

// ─── Embedded photo from disk ─────────────────────────────────────────────────

function embedPhoto(doc, storagePath, caption) {
  if (!storagePath) return;
  const resolved = path.resolve(storagePath);
  if (!resolved.startsWith('/app/uploads/')) return;
  if (!fs.existsSync(resolved)) return;
  try {
    needSpace(doc, 160);
    doc.image(resolved, MARGIN, doc.y, { fit: [CONTENT_W, 180], align: 'left' });
    doc.y += 8;
    if (caption) {
      doc.fillColor(C_MUTED).font('Helvetica').fontSize(7).text(caption, MARGIN, doc.y);
      doc.y += 12;
    }
  } catch (_) {}
}

// ─── Entity renderers ─────────────────────────────────────────────────────────

function renderModuleRecord(doc, data) {
  const fields   = parseJSON(data.fields, []);
  const recData  = parseJSON(data.data, {});
  const uploads  = data._uploads || [];

  drawHeader(doc, `${data.module_name || 'Module Record'} — Record #${data.id}`);

  section(doc, 'Record Details');
  field(doc, 'Module',       data.module_name);
  if (data._entity_name) {
    const entityLabel = data.entity_type === 'staff' ? 'Staff Member' : 'Child';
    field(doc, entityLabel,  data._entity_name);
  }
  field(doc, 'Submitted',     fmtDateTime(data.submitted_at));
  field(doc, 'Submitted by',  data._submitted_by_name);
  field(doc, 'Portal',        data.submitted_portal);

  section(doc, 'Record Data');

  for (const f of fields) {
    if (f.type === 'timestamp_auto') {
      field(doc, f.label || f.key, fmtDateTime(recData[f.key]));
      continue;
    }

    if (f.type === 'photo' || f.type === 'photo_multi' || f.type === 'signature') {
      const matching = uploads.filter(u => u.field_key === f.key);
      if (matching.length) {
        section(doc, f.label || f.key);
        for (const u of matching) {
          if (u.storage_path && u.mime_type && u.mime_type.startsWith('image/')) {
            embedPhoto(doc, u.storage_path, u.filename);
          }
        }
      }
      continue;
    }

    const val = recData[f.key];
    if (val === undefined || val === null || val === '') continue;
    const label = f.label || f.key;

    if (f.type === 'long_text') {
      textBlock(doc, label, val);
    } else if (f.type === 'yes_no') {
      field(doc, label, val === true || val === 'true' ? 'Yes' : 'No');
    } else if (f.type === 'date') {
      field(doc, label, fmtDate(val));
    } else if (f.type === 'datetime') {
      field(doc, label, fmtDateTime(val));
    } else {
      field(doc, label, safe(val));
    }
  }

  drawFooter(doc);
}

function renderObservation(doc, data) {
  drawHeader(doc, `Observation — ${data.child_name || 'Child'}`);

  section(doc, 'Details');
  field(doc, 'Child',              data.child_name);
  field(doc, 'Room',               data.room_name);
  field(doc, 'Observer',           data.staff_name || data.observed_by);
  field(doc, 'Date',               fmtDate(data.observed_at || data.created_at));
  field(doc, 'Type',               titleCase(data.observation_type));
  field(doc, 'Shared with parents', data.shared_with_parents ? 'Yes' : 'No');

  if (Array.isArray(data.eyfs_areas) && data.eyfs_areas.length) {
    tagList(doc, 'EYFS Areas', data.eyfs_areas);
  }

  if (data.observation_text)    textBlock(doc, 'Observation',          data.observation_text);
  if (data.analysis)            textBlock(doc, 'Analysis',             data.analysis);
  if (data.next_steps)          textBlock(doc, 'Next Steps',           data.next_steps);
  if (data.additional_comments) textBlock(doc, 'Additional Comments',  data.additional_comments);
  if (data.staff_notes)         textBlock(doc, 'Staff Notes',          data.staff_notes);

  const photoCount = Array.isArray(data.photo_urls) ? data.photo_urls.length : 0;
  if (photoCount) {
    section(doc, 'Photos');
    doc.fillColor(C_MUTED).font('Helvetica').fontSize(9)
       .text(`${photoCount} photo${photoCount !== 1 ? 's' : ''} attached to this observation.`,
             MARGIN, doc.y, { width: CONTENT_W });
    doc.y += 12;
  }

  drawFooter(doc);
}

function renderSupervision(doc, data) {
  drawHeader(doc, `Supervision — ${data.staff_name || 'Staff Member'}`);

  section(doc, 'Supervision Details');
  field(doc, 'Staff Member',    data.staff_name);
  field(doc, 'Role',            titleCase(data.staff_role));
  field(doc, 'Supervisor',      data.supervisor_name);
  field(doc, 'Scheduled Date',  fmtDate(data.scheduled_date));
  field(doc, 'Conducted Date',  fmtDate(data.conducted_date));
  field(doc, 'Status',          titleCase(data.status));

  if (data.wellbeing_score != null) {
    field(doc, 'Wellbeing Score', `${data.wellbeing_score}/5`);
  }
  if (data.wellbeing_rag) {
    const ragMap = {
      green: 'Green — Positive',
      amber: 'Amber — Some concerns',
      red:   'Red — Significant concerns'
    };
    field(doc, 'Wellbeing RAG', ragMap[data.wellbeing_rag] || titleCase(data.wellbeing_rag));
  }
  if (data.wellbeing_rag_reason) textBlock(doc, 'Wellbeing Notes', data.wellbeing_rag_reason);
  if (data.manager_notes)        textBlock(doc, 'Manager Notes',   data.manager_notes);
  if (data.ai_summary)           textBlock(doc, 'AI Summary',      data.ai_summary);

  // Pre-questionnaire responses
  const preQ = parseJSON(data.pre_questionnaire_responses, null);
  if (preQ && typeof preQ === 'object' && Object.keys(preQ).length) {
    section(doc, 'Pre-Supervision Questionnaire');
    for (const [key, val] of Object.entries(preQ)) {
      const label = titleCase(key);
      const display = typeof val === 'number' ? `${val}/5` : safe(val);
      field(doc, label, display);
    }
  }

  // Targets from supervision_targets table
  const dbTargets = data._targets || [];
  if (dbTargets.length) {
    section(doc, 'Targets');
    for (const t of dbTargets) {
      needSpace(doc, 36);
      const meta = [
        t.area,
        t.due_date ? `Due: ${fmtDate(t.due_date)}` : null,
        t.achieved ? 'Achieved' : null
      ].filter(Boolean).join('  ·  ');
      doc.fillColor(C_TEXT).font('Helvetica-Bold').fontSize(9)
         .text(`• ${t.target_text || ''}`, MARGIN, doc.y, { width: CONTENT_W });
      if (meta) {
        doc.fillColor(C_MUTED).font('Helvetica').fontSize(8)
           .text(meta, MARGIN + 10, doc.y, { width: CONTENT_W - 10 });
      }
      if (t.progress_notes) {
        doc.fillColor(C_MUTED).font('Helvetica').fontSize(8)
           .text(`Progress: ${t.progress_notes}`, MARGIN + 10, doc.y, { width: CONTENT_W - 10 });
      }
      doc.y += 8;
    }
  }

  // Agreed targets from JSONB (legacy / supervisor-defined)
  const agreed = parseJSON(data.agreed_targets, []);
  if (Array.isArray(agreed) && agreed.length && !dbTargets.length) {
    section(doc, 'Agreed Targets');
    for (const t of agreed) {
      needSpace(doc, 30);
      const text = safe(t.text || t);
      const meta = [
        t.area,
        t.deadline_weeks ? `${t.deadline_weeks} week${t.deadline_weeks !== 1 ? 's' : ''}` : null
      ].filter(Boolean).join('  ·  ');
      doc.fillColor(C_TEXT).font('Helvetica-Bold').fontSize(9)
         .text(`• ${text}`, MARGIN, doc.y, { width: CONTENT_W });
      if (meta) {
        doc.fillColor(C_MUTED).font('Helvetica').fontSize(8)
           .text(meta, MARGIN + 10, doc.y, { width: CONTENT_W - 10 });
      }
      doc.y += 8;
    }
  }

  drawFooter(doc);
}

function renderIncident(doc, data) {
  const isAccident = (data.incident_type || '').toLowerCase() === 'accident';
  drawHeader(doc, `${isAccident ? 'Accident' : 'Incident'} Report — ${data.child_name || 'Child'}`);

  section(doc, 'Incident Details');
  field(doc, 'Child',           data.child_name);
  field(doc, 'Room',            data.room_name);
  field(doc, 'Date',            fmtDate(data.incident_date));
  field(doc, 'Time',            data.incident_time ? String(data.incident_time).slice(0, 5) : '');
  field(doc, 'Type',            titleCase(data.incident_type));
  field(doc, 'Location',        data.location);
  field(doc, 'Reported by',     data.reporter_name);
  field(doc, 'Status',          titleCase(data.status));
  field(doc, 'RIDDOR reportable', data.riddor_reportable ? 'Yes' : 'No');

  if (data.description)        textBlock(doc, 'Description',          data.description);
  if (data.injury_description) textBlock(doc, 'Injury Description',   data.injury_description);
  if (data.body_map_area)      textBlock(doc, 'Body Map Area',         data.body_map_area);
  if (data.first_aid_given)    textBlock(doc, 'First Aid Given',       data.first_aid_given);
  if (data.witness_name)       field(doc, 'Witness', data.witness_name);
  if (data.follow_up_required) field(doc, 'Follow-up Required', 'Yes');

  if (data.parent_notified) {
    section(doc, 'Parent Notification');
    field(doc, 'Notified',    'Yes');
    if (data.parent_notified_at) field(doc, 'Notified at', fmtDateTime(data.parent_notified_at));
    if (data.parent_signed_at)   field(doc, 'Parent signed at', fmtDateTime(data.parent_signed_at));
  }

  if (data.manager_reviewed) {
    field(doc, 'Manager reviewed', 'Yes');
    if (data.manager_reviewed_at) field(doc, 'Reviewed at', fmtDateTime(data.manager_reviewed_at));
  }

  drawFooter(doc);
}

function renderDailyDiaryDay(doc, data) {
  const dateStr = fmtDate(data.date);
  drawHeader(doc, `Daily Diary — ${data.child_name || 'Child'} — ${dateStr}`);

  section(doc, 'Daily Summary');
  field(doc, 'Child', data.child_name);
  field(doc, 'Date',  dateStr);
  field(doc, 'Mood',  data.mood);

  if (data.meals) {
    const meals = parseJSON(data.meals, data.meals);
    if (meals && typeof meals === 'object' && !Array.isArray(meals)) {
      section(doc, 'Meals');
      for (const [meal, val] of Object.entries(meals)) {
        field(doc, titleCase(meal), safe(val));
      }
    } else {
      field(doc, 'Meals', safe(meals));
    }
  }

  if (data.naps) field(doc, 'Naps', safe(data.naps));

  if (data.activities) {
    const acts = Array.isArray(data.activities) ? data.activities : [safe(data.activities)];
    tagList(doc, 'Activities', acts.filter(Boolean));
  }

  if (data.notes) textBlock(doc, 'Notes', data.notes);

  const photoCount = Array.isArray(data.photo_urls) ? data.photo_urls.length : 0;
  if (photoCount) {
    section(doc, 'Photos');
    doc.fillColor(C_MUTED).font('Helvetica').fontSize(9)
       .text(`${photoCount} photo${photoCount !== 1 ? 's' : ''} attached to this diary entry.`,
             MARGIN, doc.y, { width: CONTENT_W });
    doc.y += 12;
  }

  drawFooter(doc);
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

function renderEntityToPDF(doc, entityType, data) {
  switch (entityType) {
    case 'module_record':   renderModuleRecord(doc, data);   break;
    case 'observation':     renderObservation(doc, data);    break;
    case 'supervision':     renderSupervision(doc, data);    break;
    case 'incident':        renderIncident(doc, data);       break;
    case 'daily_diary_day': renderDailyDiaryDay(doc, data);  break;
    default:
      doc.fillColor(C_MUTED).font('Helvetica').fontSize(11)
         .text(`Unknown entity type: ${entityType}`, MARGIN, doc.y);
  }
}

module.exports = { renderEntityToPDF };
