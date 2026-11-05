'use strict';

const { XMLParser } = require('fast-xml-parser');
const {
  GENDER_CODES, YN_CODES, SEN_STATUS_CODES, NC_YEAR_CODES,
  RESULT_STATUSES, DOCUMENT_QUALIFIERS,
} = require('./cbds-codes');

// fast-xml-parser options used for both validation and parsing
const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
  isArray: (name) => [
    'Pupil','ContactDetails','LanguageType','SENprovisionInfo',
    'SENstage','FSMreview','AttendanceDetails','Result','School','PhoneNumber',
  ].includes(name),
};

/**
 * Parse XML text → JS object. Throws on syntax errors.
 * Returns the raw fast-xml-parser output.
 */
function parseXML(xmlText) {
  const parser = new XMLParser(PARSER_OPTIONS);
  return parser.parse(xmlText);
}

/**
 * Validate a CTF 25 XML string.
 * Returns { valid: boolean, errors: [{path, message, line?}] }
 * Errors include line-number hints extracted by scanning the raw text.
 */
function validate(xmlText) {
  const errors = [];

  // ── 1. Syntax check ──────────────────────────────────────────────────────────
  let doc;
  try {
    doc = parseXML(xmlText);
  } catch (e) {
    const msg = e?.message || String(e);
    const line = extractLine(msg);
    return { valid: false, errors: [{ path: '/', message: `XML parse error: ${msg}`, line }] };
  }

  // ── 2. Root element ──────────────────────────────────────────────────────────
  if (!doc.CTfile) {
    errors.push({ path: '/', message: 'Root element must be <CTfile>' });
    return { valid: false, errors };
  }

  const root = doc.CTfile;
  const ctfVer = String(root['@_CTFversion'] || '').trim();
  if (ctfVer !== '25') {
    errors.push({ path: 'CTfile/@CTFversion',
      message: `CTFversion attribute must be "25", got "${ctfVer}"` });
  }

  // ── 3. Header ────────────────────────────────────────────────────────────────
  if (!root.Header) {
    errors.push({ path: 'CTfile', message: 'Missing required <Header> element' });
  } else {
    validateHeader(root.Header, errors);
  }

  // ── 4. Pupils ────────────────────────────────────────────────────────────────
  if (root.Pupils) {
    const pupils = root.Pupils.Pupil || [];
    if (!Array.isArray(pupils) || pupils.length === 0) {
      errors.push({ path: 'CTfile/Pupils', message: '<Pupils> exists but contains no <Pupil> elements' });
    } else {
      pupils.forEach((p, i) => validatePupil(p, i, errors));
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateHeader(h, errors) {
  const req = (field, path) => {
    if (!h[field] && h[field] !== 0) {
      errors.push({ path: `CTfile/Header/${path || field}`, message: `Missing required <${path || field}>` });
    }
  };

  req('DocumentName'); req('CTFversion'); req('DateTime'); req('DocumentQualifier');

  const qual = String(h.DocumentQualifier || '').trim().toLowerCase();
  if (qual && !DOCUMENT_QUALIFIERS.has(qual)) {
    errors.push({ path: 'CTfile/Header/DocumentQualifier',
      message: `DocumentQualifier must be "partial" or "full", got "${qual}"` });
  }

  if (!h.SourceSchool) {
    errors.push({ path: 'CTfile/Header/SourceSchool', message: 'Missing required <SourceSchool>' });
  } else {
    ['LEA','Estab','SchoolName'].forEach(f => {
      if (!h.SourceSchool[f]) {
        errors.push({ path: `CTfile/Header/SourceSchool/${f}`, message: `Missing <${f}> in SourceSchool` });
      }
    });
  }
}

function validatePupil(p, idx, errors) {
  const pfx = (f) => `CTfile/Pupils/Pupil[${idx + 1}]/${f}`;

  if (!p.UPN && p.UPN !== 0) {
    errors.push({ path: pfx('UPN'), message: 'Missing required <UPN>' });
  } else {
    const upn = String(p.UPN).trim();
    if (upn && !upn.startsWith('TEMP') && !/^[A-Z][0-9]{12}$/.test(upn)) {
      errors.push({ path: pfx('UPN'),
        message: `UPN "${upn}" does not match expected format (1 letter + 12 digits, or TEMP...)` });
    }
  }

  if (!p.Surname) errors.push({ path: pfx('Surname'), message: 'Missing required <Surname>' });
  if (!p.Forename) errors.push({ path: pfx('Forename'), message: 'Missing required <Forename>' });

  if (!p.DOB) {
    errors.push({ path: pfx('DOB'), message: 'Missing required <DOB>' });
  } else if (!isValidDate(String(p.DOB))) {
    errors.push({ path: pfx('DOB'),
      message: `<DOB> "${p.DOB}" is not a valid date (expected YYYY-MM-DD)` });
  }

  if (!p.Gender) {
    errors.push({ path: pfx('Gender'), message: 'Missing required <Gender>' });
  } else if (!GENDER_CODES.has(String(p.Gender).trim())) {
    errors.push({ path: pfx('Gender'),
      message: `<Gender> must be M, F or U, got "${p.Gender}"` });
  }

  if (p.NCyearActual !== undefined && p.NCyearActual !== null) {
    const ny = String(p.NCyearActual).trim();
    if (ny && !NC_YEAR_CODES.has(ny)) {
      errors.push({ path: pfx('NCyearActual'),
        message: `<NCyearActual> "${ny}" is not a valid NC year code` });
    }
  }

  if (p.InCare !== undefined && !YN_CODES.has(String(p.InCare).trim())) {
    errors.push({ path: pfx('InCare'), message: `<InCare> must be Y or N` });
  }

  if (p.ServiceChild !== undefined && !YN_CODES.has(String(p.ServiceChild).trim())) {
    errors.push({ path: pfx('ServiceChild'), message: `<ServiceChild> must be Y or N` });
  }

  if (p.SENstatus !== undefined) {
    const s = String(p.SENstatus).trim();
    if (s && !SEN_STATUS_CODES.has(s)) {
      errors.push({ path: pfx('SENstatus'), message: `<SENstatus> must be N/S/E/K, got "${s}"` });
    }
  }

  if (p.AssessmentResults?.Result) {
    (p.AssessmentResults.Result || []).forEach((r, ri) => {
      const rs = String(r.ResultStatus || '').trim();
      if (rs && !RESULT_STATUSES.has(rs)) {
        errors.push({ path: pfx(`AssessmentResults/Result[${ri + 1}]/ResultStatus`),
          message: `ResultStatus must be A/N/NA/WD, got "${rs}"` });
      }
    });
  }
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s);
  return !isNaN(d.getTime());
}

function extractLine(msg) {
  const m = msg.match(/line[:\s]+(\d+)/i);
  return m ? parseInt(m[1], 10) : undefined;
}

module.exports = { validate, parseXML, PARSER_OPTIONS };
