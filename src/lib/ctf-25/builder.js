'use strict';

/**
 * CTF 25 builder — converts Wren DB data into a valid CTF 25 XML string.
 *
 * buildCTF(opts) → XML string
 *
 * opts: {
 *   sourceSchool: { lea, estab, name, academicYear }
 *   destSchool:   { lea, estab, name }   (optional)
 *   qualifier:    'partial' | 'full'
 *   supplierID:   string  (default 'Wren')
 *   pupils: WrenExportPupil[]
 * }
 *
 * WrenExportPupil — assembled from DB by the route handler:
 *   child row + sen_register rows + ctf_* history rows
 */

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function el(tag, value, indent = '') {
  const v = value !== null && value !== undefined ? String(value).trim() : '';
  if (!v) return '';
  return `${indent}<${tag}>${esc(v)}</${tag}>\n`;
}

function elOpt(tag, value, indent = '') {
  if (value === null || value === undefined || value === '') return '';
  return el(tag, value, indent);
}

function isoDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildHeader(src, dst, qualifier, supplierID) {
  const now = new Date().toISOString().slice(0, 19);
  let xml = '  <Header>\n';
  xml += el('DocumentName', 'Common Transfer File', '    ');
  xml += el('CTFversion', '25', '    ');
  xml += el('DateTime', now, '    ');
  xml += el('DocumentQualifier', qualifier || 'partial', '    ');
  xml += elOpt('SupplierID', supplierID || 'Wren', '    ');
  xml += '    <SourceSchool>\n';
  xml += el('LEA',          src.lea   || '000', '      ');
  xml += el('Estab',        src.estab || '0000', '      ');
  xml += el('SchoolName',   src.name  || 'Unknown School', '      ');
  xml += elOpt('AcademicYear', src.academicYear, '      ');
  xml += '    </SourceSchool>\n';
  if (dst && (dst.lea || dst.estab || dst.name)) {
    xml += '    <DestSchool>\n';
    xml += elOpt('LEA',        dst.lea,   '      ');
    xml += elOpt('Estab',      dst.estab, '      ');
    xml += elOpt('SchoolName', dst.name,  '      ');
    xml += '    </DestSchool>\n';
  }
  xml += '  </Header>\n';
  return xml;
}

function buildContacts(child) {
  const contacts = [];

  // Primary contact from children table
  if (child.parent_1_name) {
    contacts.push({
      surname:  (child.parent_1_name || '').split(' ').slice(-1)[0] || child.parent_1_name,
      forename: (child.parent_1_name || '').split(' ').slice(0, -1).join(' ') || child.parent_1_name,
      parental: 'Y',
      relation: child.parent_1_relation || 'PARE',
      address1: child.address_line1,
      postcode: child.postcode,
      phone:    child.parent_1_phone,
      email:    child.parent_1_email,
    });
  }

  // Second contact
  if (child.parent_2_name) {
    contacts.push({
      surname:  (child.parent_2_name || '').split(' ').slice(-1)[0] || child.parent_2_name,
      forename: (child.parent_2_name || '').split(' ').slice(0, -1).join(' ') || child.parent_2_name,
      parental: 'Y',
      relation: child.parent_2_relation || 'PARE',
      phone:    child.parent_2_phone,
      email:    child.parent_2_email,
    });
  }

  if (!contacts.length) return '';

  let xml = '      <Contacts>\n';
  for (const c of contacts) {
    xml += '        <ContactDetails>\n';
    xml += el('Surname', c.surname, '          ');
    xml += el('Forename', c.forename, '          ');
    xml += el('ParentalResponsibility', c.parental || 'N', '          ');
    xml += elOpt('RelationshipCode', c.relation, '          ');
    if (c.address1 || c.postcode) {
      xml += '          <AddressDetails>\n';
      xml += elOpt('AddressLine1', c.address1, '            ');
      xml += elOpt('Postcode',     c.postcode, '            ');
      xml += '          </AddressDetails>\n';
    }
    if (c.phone) {
      xml += '          <Phones>\n';
      xml += '            <PhoneNumber>\n';
      xml += el('PhoneType', 'M', '              ');
      xml += el('Number', c.phone, '              ');
      xml += '            </PhoneNumber>\n';
      xml += '          </Phones>\n';
    }
    xml += elOpt('Email', c.email, '          ');
    xml += '        </ContactDetails>\n';
  }
  xml += '      </Contacts>\n';
  return xml;
}

function buildSEN(child, senHistory, senProvisions) {
  let xml = '';
  const status = child.sen_status || (child.send_needs ? 'S' : 'N');
  xml += el('SENstatus', status, '      ');

  if (senProvisions && senProvisions.length) {
    xml += '      <SENprovision>\n';
    for (const p of senProvisions) {
      xml += '        <SENprovisionInfo>\n';
      xml += el('SENtype', p.sen_type, '          ');
      xml += el('SENtypeRank', p.rank || 1, '          ');
      xml += '        </SENprovisionInfo>\n';
    }
    xml += '      </SENprovision>\n';
  }

  if (senHistory && senHistory.length) {
    xml += '      <SENhistory>\n';
    for (const s of senHistory) {
      xml += '        <SENstage>\n';
      xml += el('SENstageType',      s.stage_type,  '          ');
      xml += el('SENstageStartDate', isoDate(s.stage_start_date) || '', '          ');
      xml += '        </SENstage>\n';
    }
    xml += '      </SENhistory>\n';
  }
  return xml;
}

function buildFSM(fsmHistory, child) {
  const rows = fsmHistory || [];
  // If no history but child has pupil_premium flag, synthesise one entry
  if (!rows.length && child.pupil_premium) {
    rows.push({
      fsm_start_date: child.start_date || child.created_at || new Date().toISOString().slice(0, 10),
      fsm_end_date: null,
      fsm_eligible: true,
      fsm_uk_born: true,
    });
  }
  if (!rows.length) return '';

  let xml = '      <FSMhistory>\n';
  for (const r of rows) {
    xml += '        <FSMreview>\n';
    xml += el('FSMstartDate', isoDate(r.fsm_start_date) || '', '          ');
    xml += elOpt('FSMendDate', isoDate(r.fsm_end_date), '          ');
    xml += el('FSMeligible', r.fsm_eligible ? '1' : '0', '          ');
    xml += el('FSMukborn',   r.fsm_uk_born  ? '1' : '0', '          ');
    xml += '        </FSMreview>\n';
  }
  xml += '      </FSMhistory>\n';
  return xml;
}

function buildAssessmentResults(results) {
  if (!results || !results.length) return '';
  // Group by stage
  const byStage = {};
  for (const r of results) {
    const s = r.stage || '';
    (byStage[s] = byStage[s] || []).push(r);
  }

  let xml = '';
  for (const [stage, stageResults] of Object.entries(byStage)) {
    xml += '      <AssessmentResults>\n';
    xml += elOpt('Stage', stage, '        ');
    for (const r of stageResults) {
      xml += '        <Result>\n';
      xml += el('ResultStatus',    r.result_status    || 'NA', '          ');
      xml += elOpt('ResultQualifier', r.result_qualifier, '          ');
      xml += el('SubjectCode',     r.subject_code,          '          ');
      xml += elOpt('Method',       r.method,                '          ');
      xml += elOpt('Season',       r.season,                '          ');
      xml += elOpt('Year',         r.year,                  '          ');
      xml += elOpt('ResultMark',   r.result_mark,           '          ');
      xml += elOpt('ResultGrade',  r.result_grade,          '          ');
      xml += elOpt('ResultType',   r.result_type,           '          ');
      xml += '        </Result>\n';
    }
    xml += '      </AssessmentResults>\n';
  }
  return xml;
}

function buildSchoolHistory(history) {
  if (!history || !history.length) return '';
  let xml = '      <SchoolHistory>\n';
  for (const s of history) {
    xml += '        <School>\n';
    xml += elOpt('LEA',           s.lea,                              '          ');
    xml += elOpt('Estab',         s.estab,                            '          ');
    xml += elOpt('SchoolName',    s.school_name,                      '          ');
    xml += elOpt('EntryDate',     isoDate(s.entry_date),              '          ');
    xml += elOpt('LeavingDate',   isoDate(s.leaving_date),            '          ');
    xml += elOpt('LeavingReason', s.leaving_reason,                   '          ');
    xml += '        </School>\n';
  }
  xml += '      </SchoolHistory>\n';
  return xml;
}

function buildPupil(child) {
  const upn    = (child.upn || '').trim();
  const gender = (child.gender || 'U').trim();
  const ncYear = (child.nc_year || child.year_group || '').trim();

  let xml = '    <Pupil>\n';
  xml += el('UPN', upn || `TEMP${child.id}`, '      ');
  xml += el('Surname', child.last_name, '      ');
  xml += el('Forename', child.first_name, '      ');
  xml += elOpt('MiddleNames', child.middle_names, '      ');
  xml += elOpt('PreferredSurname',  child.preferred_surname  || child.last_name,  '      ');
  xml += elOpt('PreferredForename', child.preferred_forename || child.first_name, '      ');
  xml += el('DOB', isoDate(child.date_of_birth), '      ');
  xml += el('Gender', gender, '      ');
  xml += elOpt('NCyearActual', ncYear, '      ');
  xml += elOpt('Ethnicity',       child.ethnicity_code, '      ');
  xml += elOpt('EthnicitySource', child.ethnicity_code ? 'P' : null, '      ');

  if (child.first_language_code) {
    xml += '      <Languages>\n';
    xml += '        <LanguageType>\n';
    xml += el('LanguageTy',   'FLA',                     '          ');
    xml += el('LanguageCode', child.first_language_code, '          ');
    xml += '        </LanguageType>\n';
    xml += '      </Languages>\n';
  }

  xml += elOpt('Nationality',    child.nationality,      '      ');
  xml += elOpt('CountryofBirth', child.country_of_birth, '      ');
  xml += el('InCare',       child.looked_after   ? 'Y' : 'N', '      ');
  xml += el('ServiceChild', child.service_child  ? 'Y' : 'N', '      ');

  // SEN
  xml += buildSEN(child, child._senHistory, child._senProvisions);

  // FSM
  xml += buildFSM(child._fsmHistory, child);

  // Contacts
  xml += buildContacts(child);

  // Assessment results
  xml += buildAssessmentResults(child._assessmentResults);

  // School history
  xml += buildSchoolHistory(child._schoolHistory);

  xml += '    </Pupil>\n';
  return xml;
}

/**
 * @param {object} opts
 * @param {object} opts.sourceSchool - { lea, estab, name, academicYear }
 * @param {object} [opts.destSchool]
 * @param {string} [opts.qualifier='partial']
 * @param {string} [opts.supplierID='Wren']
 * @param {object[]} opts.pupils - augmented child rows from DB
 * @returns {string} CTF 25 XML
 */
function buildCTF({ sourceSchool, destSchool, qualifier, supplierID, pupils }) {
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
  xml += '<CTfile xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n';
  xml += '        xsi:noNamespaceSchemaLocation="CTF_25.xsd"\n';
  xml += '        CTFversion="25">\n';
  xml += buildHeader(sourceSchool, destSchool, qualifier, supplierID);
  if (pupils && pupils.length) {
    xml += '  <Pupils>\n';
    for (const p of pupils) xml += buildPupil(p);
    xml += '  </Pupils>\n';
  }
  xml += '</CTfile>\n';
  return xml;
}

/**
 * Generate the DfE-convention CTF filename.
 * Format: [SrcLEA][SrcEstab]_[DstLEA][DstEstab]_CTF_[YYYYMMDD].xml
 * Falls back to WrenYYYYMMDD if codes are missing.
 */
function buildFilename(srcLea, srcEstab, dstLea, dstEstab) {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const src = (srcLea && srcEstab) ? `${srcLea}${srcEstab}` : 'Wren';
  const dst = (dstLea && dstEstab) ? `${dstLea}${dstEstab}` : 'Unknown';
  return `${src}_${dst}_CTF_${d}.xml`;
}

module.exports = { buildCTF, buildFilename };
