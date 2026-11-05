'use strict';
/**
 * parent-media-gate.js — b265 (2026-09-01)
 * ─────────────────────────────────────────────────────────────────────────────
 * The four media controls, in one place, so every parent-facing surface applies
 * the same rules.
 *
 *   1. DOWNLOAD TOGGLE, off by default (settings.parent_media_download_enabled).
 *      Famly ships photo download off and makes a manager turn it on; Tapestry
 *      shows the button only if the setting permits. Off is the right start.
 *
 *   2. A WARNING at the point of download, naming the other-children issue in
 *      the same terms the registration form uses.
 *
 *   3. GROUP-MEDIA SUPPRESSION — the only control here that actually works.
 *      It acts at SHARE time, not download time, so a screenshot cannot defeat
 *      it. Where a family has withdrawn `learning_journey_group`, media that
 *      their child appears in is not served to OTHER families; the observation
 *      still works for everyone else, without that picture. Wren had nothing
 *      like this; Tapestry does.
 *
 *   4. WATERMARKING with the viewing family's identity (see media-watermark.js).
 *      It does not stop a screenshot. It makes a leaked image traceable, which
 *      is the only deterrent that survives one.
 *
 * WHY 3 MATTERS MORE THAN IT LOOKS HERE
 * -------------------------------------
 * Group observations are not an edge case at LADN — they are how the setting
 * works. On production at the time of writing: 7,563 observation groups, 1,997
 * genuinely multi-child, 1,877 of those carrying photos, and 1,857 of those
 * already shared with parents. The largest group has 25 children in it. A
 * control that only acts at download time leaves all 1,857 exactly as they are.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PERMS = require('./child-permissions');

const DOWNLOAD_SETTING_KEY = 'parent_media_download_enabled';

// Setting reads sit on the hot path of every photo request, so cache briefly.
// 30s is short enough that a manager flipping the toggle sees it take effect
// while they are still looking at the screen.
let _dlCache = { value: null, at: 0 };
const DL_TTL_MS = 30 * 1000;

/**
 * Is parent media download switched on? Defaults to FALSE — on a missing row,
 * a missing table, or any error. Fail-closed: the failure mode of a download
 * gate must be "no download", never "download everything".
 */
async function isDownloadEnabled(db, opts) {
  const now = Date.now();
  if (!(opts && opts.fresh) && _dlCache.value !== null && now - _dlCache.at < DL_TTL_MS) {
    return _dlCache.value;
  }
  let v = false;
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key=$1`, [DOWNLOAD_SETTING_KEY]);
    v = rows.length ? String(rows[0].value).toLowerCase() === 'true' : false;
  } catch (e) {
    console.error('[media-gate] download setting read failed, staying closed:', e.message);
    v = false;
  }
  _dlCache = { value: v, at: now };
  return v;
}

function invalidateDownloadCache() { _dlCache = { value: null, at: 0 }; }

/**
 * Verdict for one photo URL and one viewing family.
 *
 * Returns:
 *   owned   — the URL belongs to a shared observation for one of this family's
 *             children (the existing ownership check, unchanged in effect)
 *   blocked — another child in the same observation group has withdrawn
 *             `learning_journey_group`, so this family must not be served it
 *   groupSize / withheldFor — for logging and for the parents-facing count
 *
 * The family's OWN withdrawal never blocks their own copy. They asked that
 * their child not appear in other families' journeys; they did not ask to stop
 * seeing their own child.
 */
async function photoVerdict(db, photoUrl, ownedChildIds, tablePrefix) {
  const T = tablePrefix || '';
  const owned = Array.isArray(ownedChildIds) ? ownedChildIds.filter(Number.isInteger) : [];
  if (!owned.length) return { owned: false, blocked: false, groupSize: 0, withheldFor: 0 };

  // Children reachable from this photo: the rows that literally carry the URL,
  // plus every row sharing a group_uuid with one of them. Both halves are
  // needed — on production, 250 of 1,877 photo-carrying groups have the media
  // on only some of their rows, so a URL-only lookup would miss group members.
  const { rows } = await db.query(`
    WITH hit AS (
      SELECT id, child_id, group_uuid, shared_with_parents
        FROM ${T}observations
       WHERE $1 = ANY(photo_urls)
    ),
    grp AS (
      SELECT child_id FROM hit
      UNION
      SELECT o.child_id FROM ${T}observations o
        WHERE o.group_uuid IS NOT NULL
          AND o.group_uuid IN (SELECT group_uuid FROM hit WHERE group_uuid IS NOT NULL)
    )
    SELECT
      (SELECT count(*) FROM hit
        WHERE shared_with_parents = true AND child_id = ANY($2::int[]))::int AS owned_rows,
      (SELECT count(*) FROM grp)::int AS group_size,
      (SELECT count(*) FROM grp g
        WHERE NOT (g.child_id = ANY($2::int[]))
          AND EXISTS (SELECT 1 FROM ${T}child_consents cc
                       WHERE cc.child_id = g.child_id
                         AND cc.consent_type = $3
                         AND cc.granted IS FALSE))::int AS withheld_for
  `, [photoUrl, owned, PERMS.GROUP_MEDIA_KEY]);

  const r = rows[0] || { owned_rows: 0, group_size: 0, withheld_for: 0 };
  return {
    owned: r.owned_rows > 0,
    blocked: r.withheld_for > 0,
    groupSize: r.group_size,
    withheldFor: r.withheld_for,
  };
}

/**
 * Strip suppressed media out of a set of observations before they reach a
 * family's screen, in ONE query rather than one per photo.
 *
 * The observation itself is left intact — text, areas, staff, likes, comments.
 * Only the pictures another family has withdrawn come out, and the row carries
 * `photos_withheld` so the UI can say why rather than showing a silent gap.
 *
 * @param {Array} observations rows with {id, child_id, photo_urls, ...}
 * @param {Array<number>} ownedChildIds this family's children
 */
async function filterObservationPhotos(db, observations, ownedChildIds, tablePrefix) {
  const T = tablePrefix || '';
  const obs = Array.isArray(observations) ? observations : [];
  const owned = Array.isArray(ownedChildIds) ? ownedChildIds.filter(Number.isInteger) : [];
  const urls = [];
  for (const o of obs) {
    const ph = Array.isArray(o.photo_urls) ? o.photo_urls : [];
    for (const u of ph) if (u && !urls.includes(u)) urls.push(u);
  }
  if (!urls.length || !owned.length) return obs;

  let blocked = new Set();
  try {
    // Same reachability rule as photoVerdict, evaluated for every URL at once.
    const { rows } = await db.query(`
      WITH want AS (SELECT unnest($1::text[]) AS url),
      hit AS (
        SELECT w.url, o.child_id, o.group_uuid
          FROM want w JOIN ${T}observations o ON w.url = ANY(o.photo_urls)
      ),
      grp AS (
        SELECT h.url, h.child_id FROM hit h
        UNION
        SELECT h.url, o.child_id
          FROM hit h JOIN ${T}observations o ON o.group_uuid = h.group_uuid
         WHERE h.group_uuid IS NOT NULL
      )
      SELECT DISTINCT g.url
        FROM grp g
       WHERE NOT (g.child_id = ANY($2::int[]))
         AND EXISTS (SELECT 1 FROM ${T}child_consents cc
                      WHERE cc.child_id = g.child_id
                        AND cc.consent_type = $3
                        AND cc.granted IS FALSE)
    `, [urls, owned, PERMS.GROUP_MEDIA_KEY]);
    blocked = new Set(rows.map(r => r.url));
  } catch (e) {
    // Fail CLOSED on the media, open on the observation: a family still reads
    // what their key person wrote, but we do not risk showing a picture another
    // family withdrew because a query fell over.
    console.error('[media-gate] group suppression query failed, withholding group media:', e.message);
    return obs.map(o => {
      const ph = Array.isArray(o.photo_urls) ? o.photo_urls : [];
      return ph.length ? { ...o, photo_urls: [], photos_withheld: ph.length, photos_withheld_reason: 'unavailable' } : o;
    });
  }

  if (!blocked.size) return obs;
  return obs.map(o => {
    const ph = Array.isArray(o.photo_urls) ? o.photo_urls : [];
    if (!ph.length) return o;
    const kept = ph.filter(u => !blocked.has(u));
    if (kept.length === ph.length) return o;
    return {
      ...o,
      photo_urls: kept,
      photos_withheld: ph.length - kept.length,
      photos_withheld_reason: 'another_family_withdrew',
    };
  });
}

// ── Who is looking ───────────────────────────────────────────────────────────
// The watermark is only useful if a human can read it and know whose copy it
// was. A parent JWT carries the email in `name`, so without this the mark says
// "sam.okafor" rather than "Sam Okafor". Resolve the real name from the child
// record, cached, and fall back to the email when we have nothing better.
const _nameCache = new Map();
const NAME_TTL_MS = 10 * 60 * 1000;

async function viewerName(db, email, tablePrefix) {
  const key = String(email || '').toLowerCase();
  if (!key) return null;
  const hit = _nameCache.get(key);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
  let name = null;
  try {
    const T = tablePrefix || '';
    const { rows } = await db.query(`
      SELECT CASE WHEN lower(c.parent_1_email) = $1 THEN c.parent_1_name
                  WHEN lower(c.parent_2_email) = $1 THEN c.parent_2_name END AS n
        FROM ${T}parent_portal_access pa
        JOIN ${T}children c ON c.id = pa.child_id
       WHERE lower(pa.email) = $1 AND pa.is_active = true
       LIMIT 5`, [key]);
    const found = rows.map(r => r.n).find(n => n && String(n).trim());
    if (found) name = String(found).trim();
  } catch (e) {
    // Never fail a photo request over a nicety — fall back to the email.
    console.error('[media-gate] viewer name lookup:', e.message);
  }
  if (!name) name = key.split('@')[0];
  _nameCache.set(key, { name, at: Date.now() });
  if (_nameCache.size > 500) _nameCache.delete(_nameCache.keys().next().value);
  return name;
}

/** The line the UI shows where a picture has been withheld. */
const WITHHELD_NOTICE =
  'A photo from this activity is not shown here — another child\'s family has asked that '
  + 'pictures their child appears in are not shared with other families.';

module.exports = {
  DOWNLOAD_SETTING_KEY,
  isDownloadEnabled,
  invalidateDownloadCache,
  photoVerdict,
  filterObservationPhotos,
  viewerName,
  WITHHELD_NOTICE,
  DOWNLOAD_WARNING: PERMS.DOWNLOAD_WARNING,
  MEDIA_REALITY_NOTICE: PERMS.MEDIA_REALITY_NOTICE,
};
