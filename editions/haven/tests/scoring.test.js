'use strict';
// Haven clinical scoring — unit tests with known worked examples.
// Run: node editions/haven/tests/scoring.test.js
const assert = require('assert');
const { scoreMUST, scoreWaterlow, scoreNEWS2, scoreFalls } = require('../lib/scoring');

let n = 0;
function t(name, fn) { fn(); n++; console.log(`  ok ${n} — ${name}`); }

console.log('MUST');
t('healthy: BMI 24, 2% loss, not acute → 0 low', () => {
  const r = scoreMUST({ bmi: 24, weight_loss_pct: 2, acute_disease_no_intake: false });
  assert.strictEqual(r.score, 0); assert.strictEqual(r.band, 'low');
});
t('BMI 19.0 (1) + 7% loss (1) → 2 high', () => {
  const r = scoreMUST({ bmi: 19, weight_loss_pct: 7 });
  assert.strictEqual(r.score, 2); assert.strictEqual(r.band, 'high');
  assert.deepStrictEqual(r.breakdown, { bmi: 1, weight_loss: 1, acute_disease: 0 });
});
t('BMI 17 (2) + 12% loss (2) + acute (2) → 6 high', () => {
  const r = scoreMUST({ bmi: 17, weight_loss_pct: 12, acute_disease_no_intake: true });
  assert.strictEqual(r.score, 6); assert.strictEqual(r.band, 'high');
});
t('BMI 21, 5% loss → 1 medium (5% is in the 5–10 band)', () => {
  const r = scoreMUST({ bmi: 21, weight_loss_pct: 5 });
  assert.strictEqual(r.score, 1); assert.strictEqual(r.band, 'medium');
});
t('boundary: BMI 18.5 scores 1, BMI 20.0 scores 1, BMI 20.1 scores 0', () => {
  assert.strictEqual(scoreMUST({ bmi: 18.5, weight_loss_pct: 0 }).breakdown.bmi, 1);
  assert.strictEqual(scoreMUST({ bmi: 20.0, weight_loss_pct: 0 }).breakdown.bmi, 1);
  assert.strictEqual(scoreMUST({ bmi: 20.1, weight_loss_pct: 0 }).breakdown.bmi, 0);
});
t('rejects missing bmi', () => {
  assert.throws(() => scoreMUST({ weight_loss_pct: 3 }), /invalid: bmi/);
});

console.log('Waterlow');
t('fit 55yo male, all-clear → 3 low (build 0 + cont 0 + skin 0 + mob 0 + male 1 + age 2 + appetite 0)', () => {
  const r = scoreWaterlow({ build: 'average', continence: 'complete', skin_type: 'healthy',
    mobility: 'fully', sex: 'male', age: 55, appetite: 'average' });
  assert.strictEqual(r.score, 3); assert.strictEqual(r.band, 'low');
});
t('82yo female, below-average build, urine incont, dry skin, restricted mobility, poor appetite → 2+3+1+1+3+5+1 = 16 high', () => {
  const r = scoreWaterlow({ build: 'below_average', continence: 'urine_incontinent', skin_type: 'dry',
    mobility: 'restricted', sex: 'female', age: 82, appetite: 'poor' });
  assert.strictEqual(r.score, 16); assert.strictEqual(r.band, 'high');
});
t('same + broken skin (3 vs 1) + bedbound (4 vs 3) + PVD 5 → 24 very_high', () => {
  const r = scoreWaterlow({ build: 'below_average', continence: 'urine_incontinent', skin_type: 'broken',
    mobility: 'bedbound', sex: 'female', age: 82, appetite: 'poor',
    special_risks: ['peripheral_vascular_disease'] });
  assert.strictEqual(r.score, 24); assert.strictEqual(r.band, 'very_high');
});
t('band boundaries: 9→low, 10→at_risk, 15→high, 20→very_high', () => {
  // female(2) + age 75-80(4) + apathetic(2) + tissue_paper(1) = 9 base → low
  const base = { build: 'average', continence: 'complete', skin_type: 'tissue_paper',
    mobility: 'apathetic', sex: 'female', age: 76, appetite: 'average' };
  assert.strictEqual(scoreWaterlow(base).score, 9);
  assert.strictEqual(scoreWaterlow(base).band, 'low');
  assert.strictEqual(scoreWaterlow({ ...base, appetite: 'poor' }).score, 10);
  assert.strictEqual(scoreWaterlow({ ...base, appetite: 'poor' }).band, 'at_risk');
  assert.strictEqual(scoreWaterlow({ ...base, mobility: 'bedbound', appetite: 'nbm_anorexic' }).score, 14);
  assert.strictEqual(scoreWaterlow({ ...base, mobility: 'bedbound', appetite: 'nbm_anorexic', smoking: undefined, special_risks: ['smoking'] }).score, 15);
  assert.strictEqual(scoreWaterlow({ ...base, mobility: 'bedbound', appetite: 'nbm_anorexic', special_risks: ['smoking'] }).band, 'high');
  assert.strictEqual(scoreWaterlow({ ...base, mobility: 'chairbound', appetite: 'nbm_anorexic', special_risks: ['smoking', 'anaemia', 'neuro_deficit'] }).score, 22);
  assert.strictEqual(scoreWaterlow({ ...base, mobility: 'chairbound', appetite: 'nbm_anorexic', special_risks: ['smoking', 'anaemia', 'neuro_deficit'] }).band, 'very_high');
});
t('rejects unknown mobility value', () => {
  assert.throws(() => scoreWaterlow({ build: 'average', continence: 'complete', skin_type: 'healthy',
    mobility: 'sprinting', sex: 'male', age: 70, appetite: 'average' }), /invalid: mobility/);
});

console.log('NEWS2');
t('textbook normal (RR 16, SpO2 98 air, BP 120, HR 70, alert, 36.5) → 0 low', () => {
  const r = scoreNEWS2({ respiratory_rate: 16, spo2: 98, on_oxygen: false, systolic_bp: 120,
    pulse: 70, consciousness: 'A', temperature: 36.5 });
  assert.strictEqual(r.score, 0); assert.strictEqual(r.band, 'low');
});
t('RCP-style worked example: RR 22(2) SpO2 94(1) on O2(2) BP 105(1) HR 115(2) V(3) T 38.6(1) → 12 high', () => {
  const r = scoreNEWS2({ respiratory_rate: 22, spo2: 94, on_oxygen: true, systolic_bp: 105,
    pulse: 115, consciousness: 'V', temperature: 38.6 });
  assert.deepStrictEqual(r.breakdown, {
    respiratory_rate: 2, spo2: 1, supplemental_oxygen: 2, systolic_bp: 1,
    pulse: 2, consciousness: 3, temperature: 1,
  });
  assert.strictEqual(r.score, 12); assert.strictEqual(r.band, 'high');
});
t('score 5 → medium (RR 21(2), SpO2 93(2), HR 91(1), rest normal)', () => {
  const r = scoreNEWS2({ respiratory_rate: 21, spo2: 93, on_oxygen: false, systolic_bp: 130,
    pulse: 91, consciousness: 'A', temperature: 37 });
  assert.strictEqual(r.score, 5); assert.strictEqual(r.band, 'medium');
});
t('3-in-one-parameter rule: total 3 from SpO2 91 alone → low_medium with red flag', () => {
  const r = scoreNEWS2({ respiratory_rate: 16, spo2: 91, on_oxygen: false, systolic_bp: 120,
    pulse: 70, consciousness: 'A', temperature: 36.8 });
  assert.strictEqual(r.score, 3); assert.strictEqual(r.band, 'low_medium');
  assert.deepStrictEqual(r.red_flags, ['spo2']);
});
t('total 4 without any single 3 → low (not low_medium)', () => {
  // RR 21(2) + SpO2 95(1) + HR 91(1) = 4
  const r = scoreNEWS2({ respiratory_rate: 21, spo2: 95, on_oxygen: false, systolic_bp: 120,
    pulse: 91, consciousness: 'A', temperature: 37 });
  assert.strictEqual(r.score, 4); assert.strictEqual(r.band, 'low');
  assert.deepStrictEqual(r.red_flags, []);
});
t('scale 2 (hypercapnic): SpO2 90 on air scores 0; SpO2 97 on O2 scores 3', () => {
  const a = scoreNEWS2({ respiratory_rate: 16, spo2: 90, spo2_scale: 2, on_oxygen: false,
    systolic_bp: 120, pulse: 70, consciousness: 'A', temperature: 36.8 });
  assert.strictEqual(a.breakdown.spo2, 0);
  const b = scoreNEWS2({ respiratory_rate: 16, spo2: 97, spo2_scale: 2, on_oxygen: true,
    systolic_bp: 120, pulse: 70, consciousness: 'A', temperature: 36.8 });
  assert.strictEqual(b.breakdown.spo2, 3);
});
t('boundaries: RR 8→3, 9→1, 12→0, 20→0, 21→2, 25→3; BP 90→3, 91→2, 111→0, 220→3; T 35.0→3, 39.1→2', () => {
  const base = { spo2: 98, on_oxygen: false, systolic_bp: 120, pulse: 70, consciousness: 'A', temperature: 37 };
  assert.strictEqual(scoreNEWS2({ ...base, respiratory_rate: 8 }).breakdown.respiratory_rate, 3);
  assert.strictEqual(scoreNEWS2({ ...base, respiratory_rate: 9 }).breakdown.respiratory_rate, 1);
  assert.strictEqual(scoreNEWS2({ ...base, respiratory_rate: 12 }).breakdown.respiratory_rate, 0);
  assert.strictEqual(scoreNEWS2({ ...base, respiratory_rate: 20 }).breakdown.respiratory_rate, 0);
  assert.strictEqual(scoreNEWS2({ ...base, respiratory_rate: 21 }).breakdown.respiratory_rate, 2);
  assert.strictEqual(scoreNEWS2({ ...base, respiratory_rate: 25 }).breakdown.respiratory_rate, 3);
  const b2 = { respiratory_rate: 16, spo2: 98, on_oxygen: false, pulse: 70, consciousness: 'A', temperature: 37 };
  assert.strictEqual(scoreNEWS2({ ...b2, systolic_bp: 90 }).breakdown.systolic_bp, 3);
  assert.strictEqual(scoreNEWS2({ ...b2, systolic_bp: 91 }).breakdown.systolic_bp, 2);
  assert.strictEqual(scoreNEWS2({ ...b2, systolic_bp: 111 }).breakdown.systolic_bp, 0);
  assert.strictEqual(scoreNEWS2({ ...b2, systolic_bp: 220 }).breakdown.systolic_bp, 3);
  const b3 = { respiratory_rate: 16, spo2: 98, on_oxygen: false, systolic_bp: 120, pulse: 70, consciousness: 'A' };
  assert.strictEqual(scoreNEWS2({ ...b3, temperature: 35.0 }).breakdown.temperature, 3);
  assert.strictEqual(scoreNEWS2({ ...b3, temperature: 39.1 }).breakdown.temperature, 2);
});
t('confused (C) scores 3 on consciousness', () => {
  const r = scoreNEWS2({ respiratory_rate: 16, spo2: 98, on_oxygen: false, systolic_bp: 120,
    pulse: 70, consciousness: 'C', temperature: 37 });
  assert.strictEqual(r.breakdown.consciousness, 3);
});
t('rejects bad ACVPU', () => {
  assert.throws(() => scoreNEWS2({ respiratory_rate: 16, spo2: 98, systolic_bp: 120,
    pulse: 70, consciousness: 'X', temperature: 37 }), /invalid: consciousness/);
});

console.log('Falls (FRAT part 1)');
t('minimum: no falls, no meds, calm, intact → 5 low', () => {
  const r = scoreFalls({ recent_falls: 'none_last_12m', medications: 'none',
    psychological: 'none', cognitive_status: 'intact' });
  assert.strictEqual(r.score, 5); assert.strictEqual(r.band, 'low');
});
t('fall in last 3m (6) + 3+ meds (4) + mild anxiety (2) + moderate impairment (3) → 15 medium', () => {
  const r = scoreFalls({ recent_falls: 'one_or_more_last_3m', medications: 'three_or_more',
    psychological: 'mild_anxiety', cognitive_status: 'moderate_impairment' });
  assert.strictEqual(r.score, 15); assert.strictEqual(r.band, 'medium');
});
t('maximum: 8+4+4+4 → 20 high', () => {
  const r = scoreFalls({ recent_falls: 'one_or_more_last_3m_while_inpatient', medications: 'three_or_more',
    psychological: 'marked_agitation_or_poor_judgement', cognitive_status: 'severe_impairment' });
  assert.strictEqual(r.score, 20); assert.strictEqual(r.band, 'high');
});
t('auto high-risk rider forces high band even at low score', () => {
  const r = scoreFalls({ recent_falls: 'none_last_12m', medications: 'none',
    psychological: 'none', cognitive_status: 'intact', auto_high_risk: true });
  assert.strictEqual(r.score, 5); assert.strictEqual(r.band, 'high');
});
t('band boundary: 11 low, 12 medium, 16 high', () => {
  // 4+2+2+3 = 11
  assert.strictEqual(scoreFalls({ recent_falls: 'one_or_more_last_12m', medications: 'one',
    psychological: 'mild_anxiety', cognitive_status: 'moderate_impairment' }).band, 'low');
  // 4+3+2+3 = 12
  assert.strictEqual(scoreFalls({ recent_falls: 'one_or_more_last_12m', medications: 'two',
    psychological: 'mild_anxiety', cognitive_status: 'moderate_impairment' }).band, 'medium');
  // 6+3+3+4 = 16
  assert.strictEqual(scoreFalls({ recent_falls: 'one_or_more_last_3m', medications: 'two',
    psychological: 'agitated_confusion', cognitive_status: 'severe_impairment' }).band, 'high');
});

console.log(`\nAll ${n} scoring assertions passed.`);
