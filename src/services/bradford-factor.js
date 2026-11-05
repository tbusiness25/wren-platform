// Bradford Factor: B = S² × D
// S = distinct absence spells, D = total sick days
// Sources: hr_absences (historical) + absence_requests (Wren-era)
// Rolling 52-week window ending at windowEndDate

const CLASSIFY = score =>
  score > 200 ? 'very_high' :
  score > 100 ? 'high' :
  score > 50  ? 'moderate' : 'low';

async function calculateBradfordFactor(db, staffId, windowEndDate = new Date()) {
  const end = new Date(windowEndDate);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  const s = start.toISOString().split('T')[0];
  const e = end.toISOString().split('T')[0];

  const [{ rows: hist }, { rows: reqs }] = await Promise.all([
    db.query(`
      SELECT start_date, end_date, duration_days AS days
      FROM hr_absences
      WHERE staff_id=$1 AND LOWER(absence_type) LIKE 'sick%'
        AND start_date >= $2::date AND start_date <= $3::date
    `, [staffId, s, e]),
    db.query(`
      SELECT start_date, end_date, days_count AS days
      FROM absence_requests
      WHERE staff_id=$1 AND status='approved'
        AND (LOWER(request_type)='sick' OR LOWER(absence_type)='sick')
        AND start_date >= $2::date AND start_date <= $3::date
    `, [staffId, s, e]),
  ]);

  // Merge; avoid double-counting overlapping date ranges between the two sources.
  // absence_requests are authoritative for Wren-era records — drop hr_absences
  // entries whose start_date appears in absence_requests.
  const wrenDates = new Set(reqs.map(r => new Date(r.start_date).toISOString().split('T')[0]));
  const filtered = hist.filter(h => !wrenDates.has(new Date(h.start_date).toISOString().split('T')[0]));
  const episodes = [...filtered, ...reqs];

  const S = episodes.length;
  const D = episodes.reduce((sum, ep) => sum + (parseFloat(ep.days) || 1), 0);
  const score = S * S * D;

  return {
    score: Math.round(score),
    instances: S,
    days_total: Math.round(D * 10) / 10,
    classification: CLASSIFY(score),
    detail: episodes.map(ep => ({
      start: ep.start_date,
      end: ep.end_date,
      days: parseFloat(ep.days) || 1,
    })),
  };
}

module.exports = { calculateBradfordFactor };
