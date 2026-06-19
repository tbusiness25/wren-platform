'use strict';

/**
 * CTF 25 parser — converts a parsed XML document (fast-xml-parser output)
 * into normalised Wren entity objects ready for DB import.
 *
 * Input:  result of validator.parseXML(xmlText)
 * Output: { header, pupils: WrenPupil[] }
 *
 * WrenPupil shape:
 *   upn, surname, forename, preferred_surname, preferred_forename, middle_names,
 *   dob, gender, nc_year, ethnicity_code, first_language_code, nationality,
 *   country_of_birth, in_care, service_child, sen_status,
 *   sen_provisions: [{sen_type, rank}],
 *   sen_history: [{stage_type, start_date}],
 *   fsm_history: [{start_date, end_date, eligible, uk_born}],
 *   contacts: [{surname, forename, parental_responsibility, relationship_code,
 *               address_line1, address_line2, town, county, postcode,
 *               phones: [{type, number}], email}],
 *   attendance: [{year, start_date, end_date, sessions_attended,
 *                 sessions_authorised, sessions_unauthorised, sessions_possible}],
 *   assessment_results: [{stage, subject_code, result_status, result_qualifier,
 *                         method, season, year, result_mark, result_grade}],
 *   school_history: [{lea, estab, school_name, entry_date, leaving_date, leaving_reason}]
 */

function str(v) { return v !== undefined && v !== null ? String(v).trim() : null; }
function strOrNull(v) { const s = str(v); return s || null; }
function boolYN(v) { const s = str(v); return s === 'Y' ? true : s === 'N' ? false : null; }
function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? null : n;
}
function dateOrNull(v) {
  const s = str(v);
  if (!s) return null;
  // CTF uses YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}
function ensureArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function parseHeader(h) {
  const src = h.SourceSchool || {};
  const dst = h.DestSchool || {};
  return {
    document_name:     strOrNull(h.DocumentName),
    ctf_version:       strOrNull(h.CTFversion),
    date_time:         strOrNull(h.DateTime),
    qualifier:         strOrNull(h.DocumentQualifier),
    supplier_id:       strOrNull(h.SupplierID),
    source_lea:        strOrNull(src.LEA),
    source_estab:      strOrNull(src.Estab),
    source_school_name: strOrNull(src.SchoolName),
    source_academic_year: strOrNull(src.AcademicYear),
    dest_lea:          strOrNull(dst.LEA),
    dest_estab:        strOrNull(dst.Estab),
    dest_school_name:  strOrNull(dst.SchoolName),
  };
}

function parseContacts(contacts) {
  if (!contacts?.ContactDetails) return [];
  return ensureArray(contacts.ContactDetails).map(c => {
    const addr = c.AddressDetails || {};
    const phones = ensureArray(c.Phones?.PhoneNumber || []).map(p => ({
      type:   strOrNull(p.PhoneType),
      number: strOrNull(p.Number),
    }));
    return {
      surname:                 strOrNull(c.Surname),
      forename:                strOrNull(c.Forename),
      middle_names:            strOrNull(c.MiddleNames),
      parental_responsibility: boolYN(c.ParentalResponsibility),
      relationship_code:       strOrNull(c.RelationshipCode),
      order:                   intOrNull(c.Order),
      address_line1:           strOrNull(addr.AddressLine1),
      address_line2:           strOrNull(addr.AddressLine2),
      town:                    strOrNull(addr.Town),
      county:                  strOrNull(addr.County),
      postcode:                strOrNull(addr.Postcode),
      phones,
      email:                   strOrNull(c.Email),
    };
  });
}

function parseSENProvision(prov) {
  if (!prov?.SENprovisionInfo) return [];
  return ensureArray(prov.SENprovisionInfo).map(p => ({
    sen_type: strOrNull(p.SENtype),
    rank:     intOrNull(p.SENtypeRank),
  }));
}

function parseSENHistory(hist) {
  if (!hist?.SENstage) return [];
  return ensureArray(hist.SENstage).map(s => ({
    stage_type:  strOrNull(s.SENstageType),
    start_date:  dateOrNull(s.SENstageStartDate),
  }));
}

function parseFSMHistory(fsm) {
  if (!fsm?.FSMreview) return [];
  return ensureArray(fsm.FSMreview).map(r => ({
    start_date: dateOrNull(r.FSMstartDate),
    end_date:   dateOrNull(r.FSMendDate),
    eligible:   String(r.FSMeligible || '0').trim() === '1',
    uk_born:    String(r.FSMukborn  || '0').trim() === '1',
  }));
}

function parseAttendance(att) {
  if (!att?.AttendanceDetails) return [];
  return ensureArray(att.AttendanceDetails).map(d => ({
    year:                  intOrNull(d.Year),
    start_date:            dateOrNull(d.StartDate),
    end_date:              dateOrNull(d.EndDate),
    sessions_attended:     intOrNull(d.SessionsAttended),
    sessions_authorised:   intOrNull(d.SessionsAuthorised),
    sessions_unauthorised: intOrNull(d.SessionsUnauthorised),
    sessions_possible:     intOrNull(d.SessionsPossible),
    grand_total_sessions:  intOrNull(d.GrandTotalSessions),
  }));
}

function parseAssessmentResults(ar) {
  if (!ar) return [];
  const stage = strOrNull(ar.Stage);
  return ensureArray(ar.Result || []).map(r => ({
    stage,
    subject_code:      strOrNull(r.SubjectCode),
    result_status:     strOrNull(r.ResultStatus),
    result_qualifier:  strOrNull(r.ResultQualifier),
    method:            strOrNull(r.Method),
    season:            strOrNull(r.Season),
    year:              intOrNull(r.Year),
    result_mark:       strOrNull(r.ResultMark),
    result_grade:      strOrNull(r.ResultGrade),
    result_type:       strOrNull(r.ResultType),
  }));
}

function parseSchoolHistory(sh) {
  if (!sh?.School) return [];
  return ensureArray(sh.School).map(s => ({
    lea:            strOrNull(s.LEA),
    estab:          strOrNull(s.Estab),
    school_name:    strOrNull(s.SchoolName),
    entry_date:     dateOrNull(s.EntryDate),
    leaving_date:   dateOrNull(s.LeavingDate),
    leaving_reason: strOrNull(s.LeavingReason),
  }));
}

function parseFirstLanguage(langs) {
  if (!langs?.LanguageType) return null;
  const types = ensureArray(langs.LanguageType);
  const fla = types.find(l => String(l.LanguageTy || '').trim() === 'FLA');
  return fla ? strOrNull(fla.LanguageCode) : strOrNull(types[0]?.LanguageCode);
}

function parsePupil(p) {
  const upn = strOrNull(p.UPN);

  return {
    upn,
    upn_is_temp: upn ? upn.startsWith('TEMP') : true,
    surname:             strOrNull(p.Surname),
    forename:            strOrNull(p.Forename),
    middle_names:        strOrNull(p.MiddleNames),
    preferred_surname:   strOrNull(p.PreferredSurname),
    preferred_forename:  strOrNull(p.PreferredForename),
    dob:                 dateOrNull(p.DOB),
    gender:              strOrNull(p.Gender),
    nc_year:             strOrNull(p.NCyearActual),
    qc_attainment:       strOrNull(p.QCAttainment),
    ethnicity_code:      strOrNull(p.Ethnicity),
    ethnicity_source:    strOrNull(p.EthnicitySource),
    first_language_code: parseFirstLanguage(p.Languages),
    nationality:         strOrNull(p.Nationality),
    country_of_birth:    strOrNull(p.CountryofBirth),
    in_care:             boolYN(p.InCare),
    service_child:       boolYN(p.ServiceChild),
    sen_status:          strOrNull(p.SENstatus),
    sen_provisions:      parseSENProvision(p.SENprovision),
    sen_history:         parseSENHistory(p.SENhistory),
    fsm_history:         parseFSMHistory(p.FSMhistory),
    contacts:            parseContacts(p.Contacts),
    attendance:          parseAttendance(p.Attendance),
    assessment_results:  parseAssessmentResults(p.AssessmentResults),
    school_history:      parseSchoolHistory(p.SchoolHistory),
  };
}

/**
 * Top-level parse function.
 * @param {object} doc - Result of parseXML(xmlText)
 * @returns {{ header: object, pupils: object[] }}
 */
function parseCTF(doc) {
  const root = doc.CTfile || doc;
  const header = parseHeader(root.Header || {});
  const pupils = ensureArray(root.Pupils?.Pupil || []).map(parsePupil);
  return { header, pupils };
}

module.exports = { parseCTF };
