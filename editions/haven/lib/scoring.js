'use strict';
/**
 * Haven — clinical scoring tools (pure functions, no I/O).
 *
 * Implements the standard UK tools:
 *   - MUST     (Malnutrition Universal Screening Tool, BAPEN)
 *   - Waterlow (pressure ulcer risk, Waterlow 2005 revision — classic scoring items)
 *   - NEWS2    (Royal College of Physicians, 2017) — scale 1 and scale 2 SpO2
 *   - FRAT     (Falls Risk Assessment Tool, Peninsula Health — Part 1)
 *
 * Every function takes a plain inputs object and returns
 *   { score, band, breakdown, escalation }
 * and throws Error('invalid: <field>') on missing/out-of-range inputs.
 *
 * ⚠️ These encodings must be validated by a registered clinician before any
 * real-world use. They are faithful to the published tools to the best of the
 * implementer's knowledge, but Haven v1 has not had clinical sign-off.
 */

function num(v, field) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) {
    throw new Error(`invalid: ${field}`);
  }
  return n;
}

// ── MUST ─────────────────────────────────────────────────────────────────────
// Step 1: BMI  — >20 → 0 ; 18.5–20 → 1 ; <18.5 → 2
// Step 2: unplanned weight loss in past 3–6 months (%) — <5 → 0 ; 5–10 → 1 ; >10 → 2
// Step 3: acute disease effect — acutely ill AND no nutritional intake >5 days → 2
// Total: 0 low ; 1 medium ; >=2 high
function scoreMUST(inputs) {
  const bmi = num(inputs.bmi, 'bmi');
  const wl = num(inputs.weight_loss_pct, 'weight_loss_pct');
  const acute = !!inputs.acute_disease_no_intake;
  if (bmi <= 0 || bmi > 90) throw new Error('invalid: bmi');
  if (wl < 0 || wl > 100) throw new Error('invalid: weight_loss_pct');

  const bmiScore = bmi > 20 ? 0 : (bmi >= 18.5 ? 1 : 2);
  const wlScore = wl < 5 ? 0 : (wl <= 10 ? 1 : 2);
  const acuteScore = acute ? 2 : 0;
  const score = bmiScore + wlScore + acuteScore;
  const band = score === 0 ? 'low' : score === 1 ? 'medium' : 'high';
  const escalation = {
    low: 'Routine clinical care — repeat screening monthly.',
    medium: 'Observe — document dietary intake for 3 days; repeat screening.',
    high: 'Treat — refer to dietitian / nutritional support team; set goals, monitor and review care plan.',
  }[band];
  return { score, band, escalation, breakdown: { bmi: bmiScore, weight_loss: wlScore, acute_disease: acuteScore } };
}

// ── Waterlow ─────────────────────────────────────────────────────────────────
// Classic item scores; total bands: <10 low ; 10–14 at risk ; 15–19 high ; 20+ very high
const WATERLOW_ITEMS = {
  build: { average: 0, above_average: 1, obese: 2, below_average: 3 },
  continence: { complete: 0, urine_incontinent: 1, faecal_incontinent: 2, doubly_incontinent: 3 },
  skin_type: { healthy: 0, tissue_paper: 1, dry: 1, oedematous: 1, clammy: 1, discoloured: 2, broken: 3 },
  mobility: { fully: 0, restless: 1, apathetic: 2, restricted: 3, bedbound: 4, chairbound: 5 },
  sex: { male: 1, female: 2 },
  appetite: { average: 0, poor: 1, ng_tube_fluids_only: 2, nbm_anorexic: 3 },
};
function waterlowAgeScore(age) {
  if (age >= 81) return 5;
  if (age >= 75) return 4;
  if (age >= 65) return 3;
  if (age >= 50) return 2;
  if (age >= 14) return 1;
  throw new Error('invalid: age');
}
const WATERLOW_SPECIAL = {
  // tissue malnutrition
  terminal_cachexia: 8, multiple_organ_failure: 8, single_organ_failure: 5,
  peripheral_vascular_disease: 5, anaemia: 2, smoking: 1,
  // neurological deficit (4–6 — take the tool's max as entered; we expose two levels)
  neuro_deficit: 4, neuro_deficit_severe: 6,
  // major surgery / trauma
  surgery_orthopaedic_below_waist: 5, surgery_on_table_over_2h: 5, surgery_on_table_over_6h: 8,
  // medication
  cytotoxics_steroids_antiinflammatory: 4,
};
function scoreWaterlow(inputs) {
  const breakdown = {};
  let score = 0;
  for (const [item, map] of Object.entries(WATERLOW_ITEMS)) {
    const v = inputs[item];
    if (!(v in map)) throw new Error(`invalid: ${item}`);
    breakdown[item] = map[v];
    score += map[v];
  }
  const age = num(inputs.age, 'age');
  breakdown.age = waterlowAgeScore(age);
  score += breakdown.age;
  const specials = Array.isArray(inputs.special_risks) ? inputs.special_risks : [];
  breakdown.special_risks = 0;
  for (const s of specials) {
    if (!(s in WATERLOW_SPECIAL)) throw new Error(`invalid: special_risk ${s}`);
    breakdown.special_risks += WATERLOW_SPECIAL[s];
  }
  score += breakdown.special_risks;
  const band = score < 10 ? 'low' : score < 15 ? 'at_risk' : score < 20 ? 'high' : 'very_high';
  const escalation = {
    low: 'No special aids normally required — reassess on change of condition.',
    at_risk: 'At risk — begin preventative care: repositioning schedule, skin inspection.',
    high: 'High risk — pressure-relieving mattress/cushion, documented repositioning, dietitian input.',
    very_high: 'Very high risk — dynamic pressure-relieving system, intensive skin care plan, escalate to community nursing.',
  }[band];
  return { score, band, escalation, breakdown };
}

// ── NEWS2 ────────────────────────────────────────────────────────────────────
function news2RespScore(rr) {
  if (rr <= 8) return 3;
  if (rr <= 11) return 1;
  if (rr <= 20) return 0;
  if (rr <= 24) return 2;
  return 3;
}
function news2SpO2Scale1(s) {
  if (s <= 91) return 3;
  if (s <= 93) return 2;
  if (s <= 95) return 1;
  return 0;
}
// Scale 2 — for confirmed hypercapnic respiratory failure (target 88–92%)
function news2SpO2Scale2(s, onOxygen) {
  if (s <= 83) return 3;
  if (s <= 85) return 2;
  if (s <= 87) return 1;
  if (s <= 92) return 0;
  // >=93: on air scores 0; on oxygen scores rise
  if (!onOxygen) return 0;
  if (s <= 94) return 1;
  if (s <= 96) return 2;
  return 3;
}
function news2BPScore(sbp) {
  if (sbp <= 90) return 3;
  if (sbp <= 100) return 2;
  if (sbp <= 110) return 1;
  if (sbp <= 219) return 0;
  return 3;
}
function news2PulseScore(p) {
  if (p <= 40) return 3;
  if (p <= 50) return 1;
  if (p <= 90) return 0;
  if (p <= 110) return 1;
  if (p <= 130) return 2;
  return 3;
}
function news2TempScore(t) {
  if (t <= 35.0) return 3;
  if (t <= 36.0) return 1;
  if (t <= 38.0) return 0;
  if (t <= 39.0) return 1;
  return 2;
}
function scoreNEWS2(inputs) {
  const rr = num(inputs.respiratory_rate, 'respiratory_rate');
  const spo2 = num(inputs.spo2, 'spo2');
  const sbp = num(inputs.systolic_bp, 'systolic_bp');
  const pulse = num(inputs.pulse, 'pulse');
  const temp = num(inputs.temperature, 'temperature');
  const onOxygen = !!inputs.on_oxygen;
  const scale = inputs.spo2_scale === 2 ? 2 : 1;
  const acvpu = String(inputs.consciousness || '').toUpperCase();
  if (!['A', 'C', 'V', 'P', 'U'].includes(acvpu)) throw new Error('invalid: consciousness');
  if (spo2 < 50 || spo2 > 100) throw new Error('invalid: spo2');

  const breakdown = {
    respiratory_rate: news2RespScore(rr),
    spo2: scale === 2 ? news2SpO2Scale2(spo2, onOxygen) : news2SpO2Scale1(spo2),
    supplemental_oxygen: onOxygen ? 2 : 0,
    systolic_bp: news2BPScore(sbp),
    pulse: news2PulseScore(pulse),
    consciousness: acvpu === 'A' ? 0 : 3,
    temperature: news2TempScore(temp),
  };
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const red = Object.entries(breakdown)
    .filter(([k, v]) => k !== 'supplemental_oxygen' && v === 3)
    .map(([k]) => k);

  let band, escalation;
  if (score >= 7) {
    band = 'high';
    escalation = 'Emergency response — continuous monitoring; urgent clinical review (call 999/emergency team for a care-home resident deteriorating acutely).';
  } else if (score >= 5) {
    band = 'medium';
    escalation = 'Urgent response — minimum hourly observations; urgent review by a clinician (GP / 111 / community team).';
  } else if (red.length > 0) {
    band = 'low_medium';
    escalation = 'Single parameter scoring 3 — urgent review by a registered clinician to decide monitoring/escalation.';
  } else if (score >= 1) {
    band = 'low';
    escalation = 'Low risk — 4–6 hourly monitoring; assessment by a competent registered person.';
  } else {
    band = 'low';
    escalation = 'Score 0 — continue routine monitoring (minimum 12-hourly).';
  }
  return { score, band, escalation, breakdown, red_flags: red, spo2_scale: scale };
}

// ── FRAT (Falls Risk Assessment Tool — Peninsula Health, Part 1) ────────────
const FRAT_ITEMS = {
  recent_falls: { none_last_12m: 2, one_or_more_last_12m: 4, one_or_more_last_3m: 6, one_or_more_last_3m_while_inpatient: 8 },
  medications: { none: 1, one: 2, two: 3, three_or_more: 4 }, // sedatives, anti-depressants, anti-parkinsons, diuretics, anti-hypertensives, hypnotics
  psychological: { none: 1, mild_anxiety: 2, agitated_confusion: 3, marked_agitation_or_poor_judgement: 4 },
  cognitive_status: { intact: 1, mild_impairment: 2, moderate_impairment: 3, severe_impairment: 4 }, // AMTS 9-10 / 7-9 / 5-7 / <5
};
function scoreFalls(inputs) {
  const breakdown = {};
  let score = 0;
  for (const [item, map] of Object.entries(FRAT_ITEMS)) {
    const v = inputs[item];
    if (!(v in map)) throw new Error(`invalid: ${item}`);
    breakdown[item] = map[v];
    score += map[v];
  }
  // Automatic high risk: recent change in functional status/medications affecting
  // safe mobility, or dizziness/postural hypotension (tool's Part 1 rider).
  const autoHigh = !!inputs.auto_high_risk;
  let band = score <= 11 ? 'low' : score <= 15 ? 'medium' : 'high';
  if (autoHigh) band = 'high';
  const escalation = {
    low: 'Standard falls prevention — orient to environment, appropriate footwear.',
    medium: 'Medium risk — implement falls-prevention care plan; review medications with GP/pharmacist.',
    high: 'High risk — full falls-prevention plan: sensor/low bed options, physio referral, enhanced supervision, medication review.',
  }[band];
  return { score, band, escalation, breakdown, auto_high_risk: autoHigh };
}

const TOOLS = {
  must: scoreMUST,
  waterlow: scoreWaterlow,
  news2: scoreNEWS2,
  falls: scoreFalls,
};

function scoreTool(tool, inputs) {
  const fn = TOOLS[String(tool || '').toLowerCase()];
  if (!fn) throw new Error(`invalid: tool ${tool}`);
  return fn(inputs || {});
}

module.exports = { scoreMUST, scoreWaterlow, scoreNEWS2, scoreFalls, scoreTool, TOOLS };
