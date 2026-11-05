'use strict';

// DfE Common Basic Data Set code tables used in CTF 25
// Source: CBDS v1.7 / CTF 25 specification

const ETHNICITY_CODES = new Set([
  'WBRI','WIRI','WIRT','WOTH',          // White
  'MWBC','MWBA','MWAS','MOTH',          // Mixed
  'AIND','APKN','ABAN','AOTH',          // Asian/Asian British
  'BCRB','BAFR','BOTH',                 // Black/Black British
  'CHNE',                                // Chinese
  'OOTH',                                // Other
  'REFU',                                // Refused
  'NOBT',                                // Not obtained
]);

const ETHNICITY_LABELS = {
  WBRI: 'White British',
  WIRI: 'White Irish',
  WIRT: 'Traveller of Irish Heritage',
  WOTH: 'Any Other White Background',
  MWBC: 'White and Black Caribbean',
  MWBA: 'White and Black African',
  MWAS: 'White and Asian',
  MOTH: 'Any Other Mixed Background',
  AIND: 'Asian or Asian British – Indian',
  APKN: 'Asian or Asian British – Pakistani',
  ABAN: 'Asian or Asian British – Bangladeshi',
  AOTH: 'Any Other Asian Background',
  BCRB: 'Black or Black British – Caribbean',
  BAFR: 'Black or Black British – African',
  BOTH: 'Any Other Black Background',
  CHNE: 'Chinese',
  OOTH: 'Any Other Ethnic Group',
  REFU: 'Information Refused',
  NOBT: 'Not Obtained',
};

const FIRST_LANGUAGE_CODES = new Set([
  'ENG','ARA','BEN','CHI','CMN','FAR','FRE','GER','GRE','GUJ','HIN',
  'ITA','JPN','KOR','MAL','MAY','MLT','NEP','NOR','PAN','PER','POL',
  'POR','PUN','ROM','RUS','SIN','SOM','SPA','SWA','TAM','TUR','URD',
  'VIE','WEL','OTH','UNK',
]);

const FIRST_LANGUAGE_LABELS = {
  ENG: 'English', ARA: 'Arabic', BEN: 'Bengali', CHI: 'Chinese (Cantonese)',
  CMN: 'Chinese (Mandarin)', FAR: 'Farsi', FRE: 'French', GER: 'German',
  GRE: 'Greek', GUJ: 'Gujarati', HIN: 'Hindi', ITA: 'Italian',
  JPN: 'Japanese', KOR: 'Korean', MAL: 'Malayalam', MAY: 'Malay',
  MLT: 'Maltese', NEP: 'Nepali', NOR: 'Norwegian', PAN: 'Panjabi',
  PER: 'Persian', POL: 'Polish', POR: 'Portuguese', PUN: 'Punjabi',
  ROM: 'Romani', RUS: 'Russian', SIN: 'Sinhala', SOM: 'Somali',
  SPA: 'Spanish', SWA: 'Swahili', TAM: 'Tamil', TUR: 'Turkish',
  URD: 'Urdu', VIE: 'Vietnamese', WEL: 'Welsh', OTH: 'Other', UNK: 'Unknown',
};

const SEN_PROVISION_CODES = new Set([
  'ASD','HI','MLD','MSI','OTH','PD','PMLD','SEMH','SLCN','SLD','SPLD','VI',
]);

const SEN_PROVISION_LABELS = {
  ASD:  'Autistic Spectrum Disorder',
  HI:   'Hearing Impairment',
  MLD:  'Moderate Learning Difficulty',
  MSI:  'Multi-Sensory Impairment',
  OTH:  'Other Difficulty/Disability',
  PD:   'Physical Disability',
  PMLD: 'Profound & Multiple Learning Difficulty',
  SEMH: 'Social, Emotional and Mental Health',
  SLCN: 'Speech, Language and Communication Needs',
  SLD:  'Severe Learning Difficulty',
  SPLD: 'Specific Learning Difficulty',
  VI:   'Visual Impairment',
};

const SEN_STATUS_CODES = new Set(['N','S','E','K']);
const SEN_STATUS_LABELS = {
  N: 'Not SEN', S: 'SEN Support', E: 'EHCP', K: 'No Longer on Register',
};

const SEN_STAGE_TYPES = new Set(['A','B','E','K','N','S']);
const SEN_STAGE_LABELS = {
  A: 'Initial Identification',
  B: 'SEN Support (School Action Plus)',
  E: 'Education, Health and Care Plan',
  K: 'No Longer on Register',
  N: 'Not SEN',
  S: 'SEN Support (School Action)',
};

const RELATIONSHIP_CODES = new Set([
  'MOTH','FATH','STEP','GRAN','AUNC','UNCL','BROI','SISI',
  'PRSI','LOCA','FAMI','FSTR','CHMP','PARE','OTH',
]);

const RELATIONSHIP_LABELS = {
  MOTH: 'Mother', FATH: 'Father', STEP: 'Step-parent',
  GRAN: 'Grandparent', AUNC: 'Aunt', UNCL: 'Uncle',
  BROI: 'Brother', SISI: 'Sister', PRSI: 'Primary Sibling',
  LOCA: 'Local Authority', FAMI: 'Family Friend',
  FSTR: 'Foster Parent', CHMP: 'Child Minder',
  PARE: 'Parent', OTH: 'Other',
};

const NC_YEAR_CODES = new Set(['R','1','2','3','4','5','6','7','8','9','10','11','12','13','N','X']);

const ASSESSMENT_SUBJECTS = {
  PSC:    'Year 1 Phonics Screening Check',
  PSC2:   'Year 2 Phonics Screening Retake',
  KS1MA:  'KS1 Mathematics',
  KS1RE:  'KS1 Reading',
  KS1WR:  'KS1 Writing',
  KS1SC:  'KS1 Science',
  KS2MA:  'KS2 Mathematics',
  KS2EN:  'KS2 English',
  KS2RE:  'KS2 Reading',
  KS2WR:  'KS2 Writing',
  KS2GPS: 'KS2 Grammar, Punctuation and Spelling',
  KS2SC:  'KS2 Science',
  EYFSP:  'EYFS Profile',
  MTC:    'Multiplication Tables Check',
};

const LEAVING_REASONS = {
  '1':  'Other reason',
  '2':  'Moved to another maintained school',
  '3':  'Moved to independent school',
  '4':  'Moved abroad',
  '5':  'Transferred to another school within same LA',
  '6':  'Excluded permanently',
  '7':  'Died',
  '8':  'Moved to specialist unit/resource base',
  '9':  'Moved to PRU',
  '10': 'Electively home educated',
  '98': 'Unknown',
};

const GENDER_CODES = new Set(['M','F','U']);
const YN_CODES = new Set(['Y','N']);
const DOCUMENT_QUALIFIERS = new Set(['partial','full']);
const RESULT_STATUSES = new Set(['A','N','NA','WD']);
const RESULT_SEASONS = new Set(['SP','SU','AU','WI']);
const RESULT_METHODS = new Set(['T','S']);

module.exports = {
  ETHNICITY_CODES, ETHNICITY_LABELS,
  FIRST_LANGUAGE_CODES, FIRST_LANGUAGE_LABELS,
  SEN_PROVISION_CODES, SEN_PROVISION_LABELS,
  SEN_STATUS_CODES, SEN_STATUS_LABELS,
  SEN_STAGE_TYPES, SEN_STAGE_LABELS,
  RELATIONSHIP_CODES, RELATIONSHIP_LABELS,
  NC_YEAR_CODES, ASSESSMENT_SUBJECTS, LEAVING_REASONS,
  GENDER_CODES, YN_CODES, DOCUMENT_QUALIFIERS,
  RESULT_STATUSES, RESULT_SEASONS, RESULT_METHODS,
};
