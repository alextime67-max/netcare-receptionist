const { db, getCostConfig, getClinics } = require('../database/db');

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const last   = new Date(y, m, 0).getDate();
  return { start: `${monthStr}-01`, end: `${monthStr}-${last}` };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function round2(n) { return Math.round(n * 100) / 100; }

function computeClinicMonthStats(clinicId, month, config) {
  const { start, end } = monthBounds(month);
  const row = db.prepare(`
    SELECT COUNT(*)                                         AS total_calls,
           COALESCE(SUM(duration), 0)                       AS total_seconds,
           COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed_calls
    FROM calls
    WHERE clinic_id = ? AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)
  `).get(clinicId, start, end);

  const minutes    = (row.total_seconds || 0) / 60;
  const twilioCost = minutes    * (config.twilio_rate_per_min || 0.0085);
  const aiCost     = (row.completed_calls || 0) * (config.ai_rate_per_call || 0.08);

  return {
    totalCalls:     row.total_calls     || 0,
    totalMinutes:   Math.round(minutes  * 10) / 10,
    completedCalls: row.completed_calls || 0,
    twilioCost:     round2(twilioCost),
    aiCost:         round2(aiCost),
    totalCost:      round2(twilioCost + aiCost),
  };
}

function getDashboardStats() {
  const config = getCostConfig();
  const month  = currentMonth();
  const today  = todayStr();
  const { start, end } = monthBounds(month);

  const callsToday = db.prepare(
    "SELECT COUNT(*) AS n FROM calls WHERE DATE(created_at) = DATE(?)"
  ).get(today).n || 0;

  const monthRow = db.prepare(`
    SELECT COUNT(*)                                         AS total_calls,
           COALESCE(SUM(duration), 0)                       AS total_seconds,
           COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed_calls
    FROM calls
    WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
  `).get(start, end);

  const minutes     = (monthRow.total_seconds || 0) / 60;
  const aiCost      = (monthRow.completed_calls || 0) * (config.ai_rate_per_call  || 0.08);
  const twilioCost  = minutes * (config.twilio_rate_per_min || 0.0085);
  const totalCost   = aiCost + twilioCost;

  const revenue = db.prepare(
    "SELECT COALESCE(SUM(monthly_price), 0) AS n FROM clinics WHERE status = 'active'"
  ).get().n || 0;

  const profit       = revenue - totalCost;
  const aiRemaining  = (config.ai_monthly_budget || 200) - aiCost;

  return {
    callsToday,
    callsThisMonth:  monthRow.total_calls || 0,
    aiCostMonth:     round2(aiCost),
    twilioCostMonth: round2(twilioCost),
    totalCost:       round2(totalCost),
    monthlyRevenue:  round2(revenue),
    profit:          round2(profit),
    aiRemaining:     round2(aiRemaining),
    aiMonthlyBudget: config.ai_monthly_budget || 200,
    month,
  };
}

function getPerClinicCosts() {
  const config  = getCostConfig();
  const clinics = getClinics();
  const month   = currentMonth();

  return clinics.map(c => {
    const stats  = computeClinicMonthStats(c.id, month, config);
    const profit = round2((c.monthly_price || 0) - stats.totalCost);
    return {
      id:           c.id,
      name:         c.name,
      slug:         c.slug,
      status:       c.status,
      monthlyPrice: c.monthly_price || 0,
      monthlyPlan:  c.monthly_plan  || '—',
      profit,
      ...stats,
    };
  });
}

module.exports = { getDashboardStats, getPerClinicCosts, computeClinicMonthStats, currentMonth };
