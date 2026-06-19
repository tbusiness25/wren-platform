'use strict';
// GIAS (Get Information About Schools) proxy + cache
// Docs: https://get-information-schools.service.gov.uk/

const express     = require('express');
const router      = express.Router();
const { getPool } = require('../db/pool');

const GIAS_BASE = 'https://efadatacollections.education.gov.uk/sites/faf/api';
const GIAS_SEARCH = 'https://www.get-information-schools.service.gov.uk/api/schools';

// Clean postcode for cache key
function normalisePostcode(pc) {
  return (pc || '').toUpperCase().replace(/\s+/g, '').substring(0, 10);
}

// ── GET /gias/lookup?postcode=W139LU — postcode search ───────────────────────
router.get('/lookup', async (req, res) => {
  const postcode = normalisePostcode(req.query.postcode || '');
  const urn      = (req.query.urn || '').replace(/\D/g, '').substring(0, 10);
  const name     = (req.query.name || '').substring(0, 100);

  if (!postcode && !urn && !name) {
    return res.status(400).json({ error: 'Provide postcode, urn, or name' });
  }

  const db = getPool();
  const cacheKey = urn ? `urn:${urn}` : postcode ? `postcode:${postcode}` : `name:${name.toLowerCase().replace(/\s/g, '_')}`;

  try {
    // Check cache first
    const { rows: [cached] } = await db.query(`
      SELECT result_json FROM gias_cache
      WHERE cache_key=$1 AND expires_at > NOW()
    `, [cacheKey]).catch(() => ({ rows: [] }));

    if (cached) {
      return res.json({ source: 'cache', results: cached.result_json });
    }

    // Build GIAS query
    let results = [];
    try {
      results = await _fetchGias({ postcode, urn, name });
    } catch (err) {
      console.warn('[GIAS] fetch failed:', err.message);
      // Return empty rather than error — fallback to manual entry
      return res.json({ source: 'error', results: [], error: err.message });
    }

    // Store in cache (24h)
    await db.query(`
      INSERT INTO gias_cache (cache_key, result_json, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '24 hours')
      ON CONFLICT (cache_key) DO UPDATE
        SET result_json=$2, fetched_at=NOW(), expires_at=NOW() + INTERVAL '24 hours'
    `, [cacheKey, JSON.stringify(results)]).catch(() => {});

    res.json({ source: 'live', results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function _fetchGias({ postcode, urn, name }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    // GIAS doesn't have a clean public JSON API — we use the Open Data download
    // For real lookup, query the EduBase REST endpoint (requires no key for public data)
    const params = new URLSearchParams();
    if (urn)      params.set('urn', urn);
    if (postcode) params.set('postcode', postcode);
    if (name)     params.set('name', name);
    params.set('format', 'json');

    const url = `https://www.get-information-schools.service.gov.uk/Establishments/Search?${params}`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Wren-School-MIS/1.0' },
    });

    if (!res.ok) throw new Error(`GIAS HTTP ${res.status}`);

    const data = await res.json().catch(() => null);

    // Normalise into our format regardless of GIAS response shape
    const raw = Array.isArray(data) ? data : (data?.Establishments || data?.establishments || data?.results || []);
    return raw.slice(0, 5).map(_normalise);
  } finally {
    clearTimeout(timeout);
  }
}

function _normalise(e) {
  // Handle both GIAS API shapes
  return {
    urn:               e.URN        || e.urn        || e.Urn        || null,
    name:              e.EstablishmentName || e.name  || e.establishment_name || '',
    type:              e.TypeOfEstablishment?.displayName || e.type  || '',
    phase:             e.PhaseOfEducation?.displayName  || e.phase  || '',
    address_line1:     e.Street    || e.street    || '',
    address_line2:     e.Locality  || e.locality  || '',
    town:              e.Town      || e.town      || '',
    county:            e.County    || e.county    || '',
    postcode:          e.Postcode  || e.postcode  || '',
    head_title:        e.HeadTitle?.displayName  || '',
    head_first_name:   e.HeadFirstName           || '',
    head_last_name:    e.HeadLastName            || '',
    telephone:         e.TelephoneNum            || e.telephone || '',
    website:           e.SchoolWebsite           || e.website   || '',
    gender:            e.Gender?.displayName     || e.gender    || '',
    religious_character: e.ReligiousCharacter?.displayName || '',
    age_range_low:     e.StatutoryLowAge         || null,
    age_range_high:    e.StatutoryHighAge        || null,
    capacity:          e.SchoolCapacity          || null,
    ofsted_rating:     e.OfstedLastInsp          || null,
  };
}

module.exports = router;
