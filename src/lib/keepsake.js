'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Leavers keepsake builder (PROMPT 46)
// Gathers a child's whole nursery journey into a frozen "snapshot", and renders a
// warm, celebratory memory book as self-contained HTML (media inlined as base64,
// for the download) or as an HTML fragment (media via a token endpoint, for the
// installable PWA). Also renders a printable PDF keepsake.
//
// Reused by:
//   • src/routes/leavers-gift.js        (staff/manager — generate + preview + download)
//   • src/routes/keepsake-public.js     (public, token-gated — /keepsake/:token/*)
//   • src/routes/data-subject-requests  (GDPR access export re-uses the snapshot)
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const PDFDoc = require('pdfkit');

const MEDIA_DIR = process.env.KEEPSAKE_MEDIA_DIR || '/app/uploads/child-photos';
const LOGO_PATH = process.env.KEEPSAKE_LOGO || '/app/public/little-angels-logo.png';
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic']);
const VID_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg']);
const INLINE_IMG_CAP = 10 * 1024 * 1024;   // 10MB per image inlined as base64
const INLINE_VID_CAP = 30 * 1024 * 1024;   // 30MB per video inlined

const NURSERY = {
  name: 'Little Angels Day Nursery',
  address: '1A Dudley Gardens, Ealing, W13 9LU',
  phone: '020 8051 0349',
  email: 'admissions@littleangelsealing.co.uk',
  website: 'www.littleangelsealing.co.uk',
  established: '1990',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function basenameOf(url) {
  if (!url) return null;
  try { return path.basename(String(url).split('?')[0].split('#')[0]); }
  catch (_) { return null; }
}

function mediaType(url) {
  const ext = path.extname(basenameOf(url) || '').toLowerCase();
  if (IMG_EXT.has(ext)) return 'image';
  if (VID_EXT.has(ext)) return 'video';
  return null; // unknown → skipped
}

function mimeFor(basename) {
  const ext = path.extname(basename || '').toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.m4v': 'video/mp4', '.ogg': 'video/ogg',
  })[ext] || 'application/octet-stream';
}

// Resolve a stored media url to a safe on-disk path inside MEDIA_DIR (basename only —
// blocks path traversal). Returns null if it doesn't exist.
function resolveMediaPath(url) {
  const b = basenameOf(url);
  if (!b || b.includes('/') || b.includes('\\') || b.startsWith('.')) return null;
  const p = path.join(MEDIA_DIR, b);
  if (!p.startsWith(MEDIA_DIR)) return null;
  try { return fs.existsSync(p) ? p : null; } catch (_) { return null; }
}

function ageText(dob) {
  if (!dob) return '';
  const d = new Date(dob), now = new Date();
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months--;
  if (months < 0) months = 0;
  const y = Math.floor(months / 12), m = months % 12;
  if (y === 0) return `${m} month${m !== 1 ? 's' : ''}`;
  return `${y} year${y !== 1 ? 's' : ''}${m ? ` ${m} month${m !== 1 ? 's' : ''}` : ''}`;
}

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (_) { return String(d); }
}

// ── Snapshot ──────────────────────────────────────────────────────────────────
// Freezes everything the keepsake needs. `db` is a pg pool/client; queries use the
// ladn schema. Each sub-query is defensive so a missing column never aborts the gift.
async function gatherSnapshot(db, childId) {
  const q = (sql, params) => db.query(sql, params).catch(() => ({ rows: [] }));

  const [childR, aboutR, obsR, memR, diaryR, fwR, fwWordsR, bookR] = await Promise.all([
    q(`SELECT c.*, r.name AS room_name,
              s.first_name || ' ' || s.last_name AS key_person
         FROM children c
         LEFT JOIN rooms r ON r.id = c.room_id
         LEFT JOIN staff s ON s.id = c.key_person_id
        WHERE c.id = $1`, [childId]),
    q(`SELECT * FROM child_about_me WHERE child_id = $1`, [childId]),
    q(`SELECT id, title, observation_text, eyfs_areas, photo_urls, next_steps,
              created_at, author_name
         FROM observations
        WHERE child_id = $1
        ORDER BY created_at ASC`, [childId]),
    q(`SELECT title, description, happened_on, milestone_type
         FROM memory_box_entries WHERE child_id = $1
        ORDER BY happened_on ASC`, [childId]),
    q(`SELECT date, mood, activities, notes, photo_urls
         FROM daily_diary
        WHERE child_id = $1 AND photo_urls IS NOT NULL AND array_length(photo_urls,1) > 0
        ORDER BY date ASC`, [childId]),
    q(`SELECT area, status, count(*)::int n
         FROM framework_tracker WHERE child_id = $1
        GROUP BY area, status`, [childId]),
    q(`SELECT word, date_observed FROM first_words WHERE child_id = $1 ORDER BY date_observed ASC NULLS LAST`, [childId]),
    q(`SELECT cover_title, ai_highlights, staff_farewell, leaving_date FROM leavers_books WHERE child_id = $1`, [childId]),
  ]);

  if (!childR.rows.length) return null;
  const c = childR.rows[0];
  const displayName = c.preferred_name || c.first_name || 'Our little one';

  // media manifest (dedup, only files that exist on disk)
  const media = [];
  const seen = new Set();
  const addMedia = (urls, caption, date) => {
    (urls || []).forEach(u => {
      const type = mediaType(u); const b = basenameOf(u);
      if (!type || !b || seen.has(b)) return;
      if (!resolveMediaPath(u)) return;   // only include media we can actually serve
      seen.add(b);
      media.push({ url: u, basename: b, type, caption: caption || '', date: date || null });
    });
  };

  // Learning-journey timeline (observations, each with its media)
  const timeline = obsR.rows.map(o => {
    addMedia(o.photo_urls, o.title || 'Observation', o.created_at);
    return {
      kind: 'observation',
      title: o.title || 'A special moment',
      text: o.observation_text || '',
      date: o.created_at,
      eyfs_areas: o.eyfs_areas || [],
      next_steps: o.next_steps || '',
      staff: o.author_name || '',
      media: (o.photo_urls || []).map(u => ({ basename: basenameOf(u), type: mediaType(u) }))
                                 .filter(m => m.basename && m.type && resolveMediaPath(m.basename)),
    };
  });
  // diary photo days feed into the gallery
  diaryR.rows.forEach(d => addMedia(d.photo_urls, 'A lovely day', d.date));

  // framework progress rollup
  const fwMap = {};
  fwR.rows.forEach(r => {
    const a = r.area || 'General';
    fwMap[a] = fwMap[a] || { area: a, secure: 0, developing: 0, emerging: 0 };
    const st = (r.status || '').toLowerCase();
    if (st === 'secure') fwMap[a].secure += r.n;
    else if (st === 'developing') fwMap[a].developing += r.n;
    else fwMap[a].emerging += r.n;
  });
  const framework = Object.values(fwMap);
  const secureTotal = framework.reduce((s, a) => s + a.secure, 0);

  // curated "all about me" — only the warm, share-appropriate fields
  const ab = aboutR.rows[0] || null;
  const about_me = ab ? {
    interests: ab.interests, skills: ab.skills, comforts: ab.comforts,
    special_days: ab.special_days, first_language: ab.first_language,
    food_preferences: ab.food_preferences,
  } : null;

  const book = bookR.rows[0] || null;

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    nursery: NURSERY,
    child: {
      id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      display_name: displayName,
      dob: c.date_of_birth,
      age_text: ageText(c.date_of_birth),
      room_name: c.room_name || '',
      key_person: c.key_person || '',
      start_date: c.start_date,
      leave_date: c.leave_date || (book && book.leaving_date) || null,
      photo: c.photo_url && resolveMediaPath(c.photo_url)
        ? { basename: basenameOf(c.photo_url), type: 'image' } : null,
    },
    about_me,
    farewell: book ? { ai_highlights: book.ai_highlights || '', staff_farewell: book.staff_farewell || '', cover_title: book.cover_title || '' } : null,
    stats: {
      observations: obsR.rows.length,
      memories: memR.rows.length,
      photos: media.filter(m => m.type === 'image').length,
      videos: media.filter(m => m.type === 'video').length,
      first_words: fwWordsR.rows.length,
      framework_secure: secureTotal,
    },
    framework,
    first_words: fwWordsR.rows.map(w => ({ word: w.word, date: w.date_observed })),
    memories: memR.rows.map(m => ({
      title: m.title, description: m.description || '',
      date: m.happened_on, type: m.milestone_type || 'memory',
    })),
    timeline,
    media,
  };
}

// ── Read a media file → base64 data URI (for the self-contained download) ───────
function inlineMediaUri(basename) {
  try {
    const p = resolveMediaPath(basename);
    if (!p) return null;
    const stat = fs.statSync(p);
    const type = mediaType(basename);
    const cap = type === 'video' ? INLINE_VID_CAP : INLINE_IMG_CAP;
    if (stat.size > cap) return null;
    const buf = fs.readFileSync(p);
    return `data:${mimeFor(basename)};base64,${buf.toString('base64')}`;
  } catch (_) { return null; }
}

// Build a { basename: dataURI } map for all media in the snapshot (bounded total).
function inlineAllMedia(snapshot, totalCapBytes = 220 * 1024 * 1024) {
  const map = {};
  let total = 0;
  const all = [...(snapshot.media || [])];
  if (snapshot.child && snapshot.child.photo) all.unshift({ basename: snapshot.child.photo.basename });
  for (const m of all) {
    if (!m || !m.basename || map[m.basename]) continue;
    const p = resolveMediaPath(m.basename);
    if (!p) continue;
    let size = 0; try { size = fs.statSync(p).size; } catch (_) { continue; }
    if (total + size > totalCapBytes) continue;
    const uri = inlineMediaUri(m.basename);
    if (uri) { map[m.basename] = uri; total += size; }
  }
  return map;
}

// ── HTML rendering ──────────────────────────────────────────────────────────
// `resolve(basename)` → the src to use for a piece of media (data URI or endpoint URL).
// Returns the inner book markup; wrap with wrapDocument() for a standalone file.
function renderBookInner(snapshot, resolve) {
  const s = snapshot, ch = s.child;
  const R = b => (b && resolve ? resolve(b) : '');
  const heroPhoto = ch.photo ? R(ch.photo.basename) : '';

  const mediaTile = (m) => {
    const src = R(m.basename);
    if (!src) return '';
    if (m.type === 'video') {
      return `<figure class="ktile"><video controls preload="metadata" src="${esc(src)}"></video>${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`;
    }
    return `<figure class="ktile"><a href="${esc(src)}" data-lightbox target="_blank" rel="noopener"><img loading="lazy" src="${esc(src)}" alt="${esc(m.caption || 'Nursery memory')}"></a>${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`;
  };

  const cover = `
    <header class="kcover">
      ${heroPhoto ? `<div class="kavatar"><img src="${esc(heroPhoto)}" alt="${esc(ch.display_name)}"></div>` : `<div class="kavatar kavatar--placeholder">${esc((ch.display_name || '?').charAt(0))}</div>`}
      <p class="keyebrow">My time at ${esc(s.nursery.name)}</p>
      <h1 class="ktitle">${esc(ch.display_name)}</h1>
      <p class="ksub">
        ${ch.room_name ? esc(ch.room_name) : ''}${ch.key_person ? ` &middot; Key person ${esc(ch.key_person)}` : ''}
      </p>
      <p class="kdates">
        ${ch.start_date ? `Joined us ${esc(fmtDate(ch.start_date))}` : ''}${ch.leave_date ? ` &mdash; and off to school ${esc(fmtDate(ch.leave_date))}` : ''}
      </p>
    </header>`;

  const stats = `
    <section class="kstats">
      ${[['📸', s.stats.photos, 'photos'], ['🎬', s.stats.videos, 'videos'], ['⭐', s.stats.memories, 'special moments'],
         ['📝', s.stats.observations, 'observations'], ['🗣️', s.stats.first_words, 'first words'], ['🌱', s.stats.framework_secure, 'skills secured']]
        .filter(([, n]) => n)
        .map(([i, n, l]) => `<div class="kstat"><div class="ki">${i}</div><div class="kn">${n}</div><div class="kl">${esc(l)}</div></div>`).join('')}
    </section>`;

  const farewell = s.farewell && (s.farewell.ai_highlights || s.farewell.staff_farewell) ? `
    <section class="kcard kfarewell">
      <h2>💛 A message from all of us</h2>
      ${s.farewell.ai_highlights ? `<div class="kprose">${esc(s.farewell.ai_highlights).replace(/\n/g, '<br>')}</div>` : ''}
      ${s.farewell.staff_farewell ? `<div class="kprose kprose--sign">${esc(s.farewell.staff_farewell).replace(/\n/g, '<br>')}</div>` : ''}
    </section>` : '';

  const about = s.about_me && Object.values(s.about_me).some(Boolean) ? `
    <section class="kcard">
      <h2>🧸 All about ${esc(ch.first_name || ch.display_name)}</h2>
      <div class="kabout">
        ${[['Loves', s.about_me.interests], ['Brilliant at', s.about_me.skills], ['Comforts', s.about_me.comforts],
           ['Special days', s.about_me.special_days], ['Favourite foods', s.about_me.food_preferences], ['Home language', s.about_me.first_language]]
          .filter(([, v]) => v && String(v).trim())
          .map(([k, v]) => `<div class="kabout-row"><span class="kabout-k">${esc(k)}</span><span class="kabout-v">${esc(v)}</span></div>`).join('')}
      </div>
    </section>` : '';

  const memories = (s.memories || []).length ? `
    <section class="kcard">
      <h2>⭐ Special moments</h2>
      <ol class="ktimeline">
        ${s.memories.map(m => `<li>
          <div class="kt-dot"></div>
          <div class="kt-body">
            <div class="kt-date">${esc(fmtDate(m.date))}</div>
            <div class="kt-title">${esc(m.title)}</div>
            ${m.description ? `<div class="kt-text">${esc(m.description)}</div>` : ''}
          </div></li>`).join('')}
      </ol>
    </section>` : '';

  const journey = (s.timeline || []).length ? `
    <section class="kcard">
      <h2>📖 ${esc(ch.first_name || 'The')}'s learning journey</h2>
      <div class="kjourney">
        ${s.timeline.map(o => `<article class="kobs">
          <div class="kobs-head">
            <div class="kobs-title">${esc(o.title)}</div>
            <div class="kobs-meta">${esc(fmtDate(o.date))}${o.staff ? ` &middot; ${esc(o.staff)}` : ''}</div>
          </div>
          ${o.text ? `<div class="kobs-text">${esc(o.text)}</div>` : ''}
          ${(o.eyfs_areas || []).length ? `<div class="kchips">${o.eyfs_areas.map(a => `<span class="kchip">${esc(a)}</span>`).join('')}</div>` : ''}
          ${(o.media || []).length ? `<div class="kgrid kgrid--inline">${o.media.map(m => mediaTile({ basename: m.basename, type: m.type, caption: '' })).join('')}</div>` : ''}
          ${o.next_steps ? `<div class="kobs-next"><b>Next steps:</b> ${esc(o.next_steps)}</div>` : ''}
        </article>`).join('')}
      </div>
    </section>` : '';

  const learning = (s.framework || []).length ? `
    <section class="kcard">
      <h2>🌱 How ${esc(ch.first_name || 'they')} grew</h2>
      <div class="kbars">
        ${s.framework.map(a => {
          const tot = a.secure + a.developing + a.emerging || 1;
          const pct = Math.round((a.secure / tot) * 100);
          return `<div class="kbar-row"><div class="kbar-l">${esc(a.area)}</div>
            <div class="kbar"><div class="kbar-fill" style="width:${pct}%"></div></div>
            <div class="kbar-n">${a.secure} secure</div></div>`;
        }).join('')}
      </div>
    </section>` : '';

  const words = (s.first_words || []).length ? `
    <section class="kcard">
      <h2>🗣️ First words</h2>
      <div class="kwords">${s.first_words.map(w => `<span class="kword">${esc(w.word)}</span>`).join('')}</div>
    </section>` : '';

  const gallery = (s.media || []).length ? `
    <section class="kcard">
      <h2>📸 ${esc(ch.first_name || 'Our')}'s gallery</h2>
      <div class="kgrid">${s.media.map(mediaTile).join('')}</div>
    </section>` : '';

  const footer = `
    <footer class="kfoot">
      <div class="kfoot-love">Made with love by everyone at ${esc(s.nursery.name)} 💛</div>
      <div class="kfoot-info">${esc(s.nursery.address)} &middot; ${esc(s.nursery.phone)}<br>${esc(s.nursery.email)} &middot; ${esc(s.nursery.website)} &middot; Established ${esc(s.nursery.established)}</div>
      <div class="kfoot-note">This keepsake was created for ${esc(ch.display_name)}'s family and is yours to keep forever.</div>
    </footer>`;

  return `<div class="kbook">${cover}${stats}${farewell}${about}${memories}${journey}${learning}${words}${gallery}${footer}</div>`;
}

const BOOK_CSS = `
:root{--k-ink:#3a2f2a;--k-soft:#8a7a70;--k-blue:#4a9abf;--k-orange:#e07820;--k-cream:#fbf7f0;--k-card:#ffffff;--k-line:#efe6d8}
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(#fdf9f2,#f6eee1);font-family:'Nunito',system-ui,Arial,sans-serif;color:var(--k-ink);-webkit-font-smoothing:antialiased}
.kbook{max-width:820px;margin:0 auto;padding:18px 16px 40px}
h1,h2{font-family:'Arial Rounded MT Bold','Nunito',Arial,sans-serif}
.kcover{text-align:center;padding:30px 16px 22px;background:var(--k-card);border-radius:24px;border:1px solid var(--k-line);box-shadow:0 8px 30px rgba(120,90,50,.08);margin-bottom:16px}
.kavatar{width:132px;height:132px;border-radius:50%;overflow:hidden;margin:0 auto 14px;border:5px solid #fff;box-shadow:0 6px 20px rgba(120,90,50,.18)}
.kavatar img{width:100%;height:100%;object-fit:cover}
.kavatar--placeholder{display:flex;align-items:center;justify-content:center;font-size:3.4rem;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--k-blue),var(--k-orange))}
.keyebrow{color:var(--k-orange);font-weight:800;letter-spacing:.04em;text-transform:uppercase;font-size:.78rem;margin:0 0 4px}
.ktitle{font-size:2.4rem;margin:0;color:var(--k-blue)}
.ksub{color:var(--k-ink);font-weight:700;margin:6px 0 2px}
.kdates{color:var(--k-soft);margin:0;font-size:.92rem}
.kstats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:10px;margin:0 0 16px}
.kstat{background:var(--k-card);border:1px solid var(--k-line);border-radius:16px;padding:12px 6px;text-align:center}
.kstat .ki{font-size:1.3rem}.kstat .kn{font-size:1.5rem;font-weight:800;color:var(--k-orange);line-height:1.1}
.kstat .kl{font-size:.72rem;color:var(--k-soft);text-transform:uppercase;letter-spacing:.03em}
.kcard{background:var(--k-card);border:1px solid var(--k-line);border-radius:20px;padding:20px 22px;margin:0 0 16px;box-shadow:0 4px 18px rgba(120,90,50,.05)}
.kcard h2{margin:0 0 14px;font-size:1.35rem;color:var(--k-blue)}
.kprose{line-height:1.7;font-size:1.02rem;white-space:normal}
.kprose--sign{margin-top:12px;font-style:italic;color:var(--k-soft)}
.kfarewell{background:linear-gradient(135deg,#fff6ea,#fdeede);border-color:#f5dcc0}
.kabout{display:grid;gap:10px}
.kabout-row{display:flex;gap:12px;align-items:baseline;border-bottom:1px dashed var(--k-line);padding-bottom:8px}
.kabout-k{min-width:118px;color:var(--k-orange);font-weight:800;font-size:.86rem}
.kabout-v{color:var(--k-ink)}
.ktimeline{list-style:none;margin:0;padding:0}
.ktimeline li{position:relative;padding:0 0 16px 24px;border-left:2px solid var(--k-line);margin-left:6px}
.ktimeline li:last-child{border-left-color:transparent}
.kt-dot{position:absolute;left:-7px;top:2px;width:12px;height:12px;border-radius:50%;background:var(--k-orange);border:3px solid #fff;box-shadow:0 0 0 1px var(--k-line)}
.kt-date{font-size:.78rem;color:var(--k-soft)}
.kt-title{font-weight:800;margin:2px 0}
.kt-text{color:var(--k-ink);line-height:1.55}
.kjourney{display:grid;gap:14px}
.kobs{border:1px solid var(--k-line);border-radius:16px;padding:14px 16px;background:#fffdf9}
.kobs-head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline}
.kobs-title{font-weight:800;color:var(--k-ink)}
.kobs-meta{font-size:.78rem;color:var(--k-soft)}
.kobs-text{margin:8px 0;line-height:1.6}
.kchips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.kchip{background:#eaf4f9;color:#2b6c8a;border-radius:20px;padding:3px 10px;font-size:.74rem;font-weight:700}
.kobs-next{margin-top:8px;font-size:.88rem;color:var(--k-soft);background:#f7f2ea;border-radius:10px;padding:8px 11px}
.kbars{display:grid;gap:12px}
.kbar-row{display:grid;grid-template-columns:130px 1fr auto;gap:12px;align-items:center}
.kbar-l{font-weight:700;font-size:.86rem}
.kbar{background:#f0e7d8;border-radius:20px;height:14px;overflow:hidden}
.kbar-fill{height:100%;background:linear-gradient(90deg,var(--k-blue),var(--k-orange));border-radius:20px}
.kbar-n{font-size:.78rem;color:var(--k-soft);white-space:nowrap}
.kwords{display:flex;flex-wrap:wrap;gap:8px}
.kword{background:linear-gradient(135deg,#fff2e0,#ffe6cc);color:var(--k-orange);font-weight:800;border-radius:20px;padding:6px 14px;font-size:1rem;border:1px solid #f6d9b8}
.kgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.kgrid--inline{margin-top:10px;grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
.ktile{margin:0;border-radius:14px;overflow:hidden;background:#f2eadc;border:1px solid var(--k-line)}
.ktile img,.ktile video{width:100%;height:150px;object-fit:cover;display:block;cursor:zoom-in}
.ktile figcaption{font-size:.72rem;color:var(--k-soft);padding:5px 8px}
.kfoot{text-align:center;padding:26px 12px 8px;color:var(--k-soft)}
.kfoot-love{font-size:1.1rem;font-weight:800;color:var(--k-orange);margin-bottom:8px}
.kfoot-info{font-size:.82rem;line-height:1.6}
.kfoot-note{font-size:.78rem;margin-top:10px;font-style:italic}
@media(max-width:520px){.ktitle{font-size:1.9rem}.kbar-row{grid-template-columns:90px 1fr auto}.kabout-k{min-width:92px}}
`;

function wrapDocument(inner, title, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;800&display=swap" rel="stylesheet">
<style>${BOOK_CSS}</style>
${extraHead}
</head>
<body>${inner}
<script>
// tiny lightbox — event-delegated so it works whether the book is rendered inline or injected
(function(){document.addEventListener('click',function(e){var a=e.target.closest('[data-lightbox]');if(!a)return;e.preventDefault();var o=document.createElement('div');o.style.cssText='position:fixed;inset:0;background:rgba(30,20,10,.92);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:zoom-out;padding:16px';o.innerHTML='<img src="'+a.getAttribute('href')+'" style="max-width:100%;max-height:100%;border-radius:12px;box-shadow:0 10px 50px rgba(0,0,0,.5)">';o.addEventListener('click',function(){o.remove()});document.body.appendChild(o);});})();
</script>
</body></html>`;
}

// Self-contained downloadable memory book (media inlined as base64).
function renderStandaloneBook(snapshot) {
  const uris = inlineAllMedia(snapshot);
  const inner = renderBookInner(snapshot, b => uris[b] || null);
  return wrapDocument(inner, `${snapshot.child.display_name} — My Little Angels Memory Book`);
}

// Book fragment for the PWA (media via the token endpoint, e.g. "./media?b=<basename>").
function renderBookFragment(snapshot, mediaBase) {
  return renderBookInner(snapshot, b => `${mediaBase}${encodeURIComponent(b)}`);
}

// ── PDF keepsake ──────────────────────────────────────────────────────────────
function renderBookPDF(snapshot) {
  const s = snapshot, ch = s.child;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDoc({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width, M = 56, CW = W - M * 2;
      // Cover band
      doc.rect(0, 0, W, 210).fill('#fbf1e3');
      let photoBottom = 70;
      if (ch.photo) {
        const p = resolveMediaPath(ch.photo.basename);
        if (p) { try { doc.save().rect(W / 2 - 46, 44, 92, 92).clip().image(p, W / 2 - 46, 44, { fit: [92, 92], align: 'center' }).restore(); photoBottom = 150; } catch (_) {} }
      }
      doc.fillColor('#e07820').fontSize(10).font('Helvetica-Bold').text('MY TIME AT LITTLE ANGELS DAY NURSERY', M, photoBottom, { width: CW, align: 'center', characterSpacing: 1 });
      doc.fillColor('#4a9abf').fontSize(30).font('Helvetica-Bold').text(ch.display_name || '', M, photoBottom + 16, { width: CW, align: 'center' });
      doc.fillColor('#8a7a70').fontSize(11).font('Helvetica').text(
        [ch.room_name, ch.key_person ? `Key person ${ch.key_person}` : ''].filter(Boolean).join('  ·  '),
        M, photoBottom + 54, { width: CW, align: 'center' });
      if (ch.start_date || ch.leave_date) {
        doc.text([ch.start_date ? `Joined ${fmtDate(ch.start_date)}` : '', ch.leave_date ? `off to school ${fmtDate(ch.leave_date)}` : ''].filter(Boolean).join('  —  '),
          M, photoBottom + 70, { width: CW, align: 'center' });
      }
      doc.y = 236;

      const h2 = (t) => { if (doc.y > doc.page.height - 130) doc.addPage(); doc.moveDown(0.6); doc.fillColor('#4a9abf').fontSize(15).font('Helvetica-Bold').text(t); doc.moveDown(0.3); };
      const para = (t) => { doc.fillColor('#3a2f2a').fontSize(10.5).font('Helvetica').text(t, { lineGap: 3 }); };

      if (s.farewell && (s.farewell.ai_highlights || s.farewell.staff_farewell)) {
        h2('A message from all of us');
        if (s.farewell.ai_highlights) para(s.farewell.ai_highlights);
        if (s.farewell.staff_farewell) { doc.moveDown(0.5); doc.font('Helvetica-Oblique').fillColor('#8a7a70').fontSize(10.5).text(s.farewell.staff_farewell, { lineGap: 3 }); }
      }
      if (s.about_me && Object.values(s.about_me).some(Boolean)) {
        h2(`All about ${ch.first_name || ch.display_name}`);
        [['Loves', s.about_me.interests], ['Brilliant at', s.about_me.skills], ['Comforts', s.about_me.comforts],
         ['Special days', s.about_me.special_days], ['Favourite foods', s.about_me.food_preferences]]
          .filter(([, v]) => v && String(v).trim())
          .forEach(([k, v]) => { doc.fillColor('#e07820').font('Helvetica-Bold').fontSize(10).text(k + ': ', { continued: true }).fillColor('#3a2f2a').font('Helvetica').text(String(v)); });
      }
      if ((s.memories || []).length) {
        h2('Special moments');
        s.memories.forEach(m => {
          if (doc.y > doc.page.height - 110) doc.addPage();
          doc.fillColor('#8a7a70').fontSize(8.5).font('Helvetica').text(fmtDate(m.date));
          doc.fillColor('#3a2f2a').fontSize(11).font('Helvetica-Bold').text(m.title);
          if (m.description) doc.fontSize(10).font('Helvetica').text(m.description, { lineGap: 2 });
          doc.moveDown(0.4);
        });
      }
      if ((s.timeline || []).length) {
        h2(`${ch.first_name || 'The'}'s learning journey`);
        s.timeline.slice(0, 40).forEach(o => {
          if (doc.y > doc.page.height - 120) doc.addPage();
          doc.fillColor('#3a2f2a').fontSize(11).font('Helvetica-Bold').text(o.title, { continued: true })
             .fillColor('#8a7a70').fontSize(8.5).font('Helvetica').text('   ' + fmtDate(o.date));
          if (o.text) doc.fillColor('#3a2f2a').fontSize(10).font('Helvetica').text(o.text, { lineGap: 2 });
          if ((o.eyfs_areas || []).length) doc.fillColor('#2b6c8a').fontSize(8.5).font('Helvetica-Oblique').text((o.eyfs_areas).join('  ·  '));
          doc.moveDown(0.4);
        });
      }
      if ((s.first_words || []).length) {
        h2('First words');
        doc.fillColor('#e07820').fontSize(12).font('Helvetica-Bold').text(s.first_words.map(w => w.word).join('   ·   '), { lineGap: 3 });
      }

      // A photo gallery page (up to 9 images)
      const imgs = (s.media || []).filter(m => m.type === 'image').map(m => resolveMediaPath(m.basename)).filter(Boolean).slice(0, 9);
      if (imgs.length) {
        doc.addPage();
        doc.fillColor('#4a9abf').fontSize(15).font('Helvetica-Bold').text(`${ch.first_name || 'Our'}'s gallery`);
        doc.moveDown(0.5);
        const cols = 3, gap = 10, cw = (CW - gap * (cols - 1)) / cols, chh = cw;
        let x = M, y = doc.y, col = 0;
        imgs.forEach(p => {
          try { doc.save().rect(x, y, cw, chh).clip().image(p, x, y, { fit: [cw, chh], align: 'center', valign: 'center' }).restore(); } catch (_) {}
          col++; if (col >= cols) { col = 0; x = M; y += chh + gap; if (y > doc.page.height - chh - 60) { doc.addPage(); y = 60; } }
          else x += cw + gap;
        });
        doc.y = y + chh + gap;
      }

      doc.moveDown(1);
      doc.fillColor('#e07820').fontSize(11).font('Helvetica-Bold').text('Made with love by everyone at Little Angels Day Nursery 💛', { align: 'center' });
      doc.fillColor('#8a7a70').fontSize(8.5).font('Helvetica').text(`${NURSERY.address} · ${NURSERY.phone} · ${NURSERY.website}`, { align: 'center' });
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = {
  NURSERY, MEDIA_DIR,
  gatherSnapshot,
  resolveMediaPath, mediaType, mimeFor, basenameOf,
  renderStandaloneBook, renderBookFragment, renderBookInner, wrapDocument, BOOK_CSS,
  inlineAllMedia, inlineMediaUri,
  renderBookPDF,
  esc, fmtDate,
};
