// api/forecast-kpi.js
// 매출 예측 + 직원 효율 KPI

import { supabaseSvc } from '../lib/auth.js';

const TICKET_PRICE = 5000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    if (!supabaseSvc) return res.status(200).json({ ok: true, fallback: true });

    const result = { ok: true, generatedAt: new Date().toISOString() };

    // ─── 1. 최근 30일 일별 입장객 (매출 예측 그래프용) ───
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: checkins } = await supabaseSvc
      .from('visitor_checkins')
      .select('visitor_id, checked_in_at')
      .gte('checked_in_at', monthAgo)
      .order('checked_in_at', { ascending: true });

    // 일별 unique 방문객
    const dailyVisitors = {};
    (checkins || []).forEach(c => {
      const day = c.checked_in_at.slice(0, 10);
      if (!dailyVisitors[day]) dailyVisitors[day] = new Set();
      dailyVisitors[day].add(c.visitor_id);
    });
    const daily = Object.entries(dailyVisitors).map(([day, set]) => ({
      day, visitors: set.size, revenue: set.size * TICKET_PRICE,
    })).sort((a, b) => a.day.localeCompare(b.day));
    result.daily = daily;

    // ─── 2. 매출 예측 (최근 7일 기반 다음 7일 예측) ───
    const last7Days = daily.slice(-7);
    if (last7Days.length >= 3) {
      const avgVisitors = last7Days.reduce((s, d) => s + d.visitors, 0) / last7Days.length;
      // 트렌드 분석 (간단한 선형)
      const firstHalf = last7Days.slice(0, Math.floor(last7Days.length / 2));
      const secondHalf = last7Days.slice(Math.floor(last7Days.length / 2));
      const trend = secondHalf.length > 0 && firstHalf.length > 0
        ? (secondHalf.reduce((s, d) => s + d.visitors, 0) / secondHalf.length) -
          (firstHalf.reduce((s, d) => s + d.visitors, 0) / firstHalf.length)
        : 0;

      // 다음 7일 예측
      const forecast = [];
      for (let i = 1; i <= 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);
        const dayOfWeek = date.getDay();
        // 주말 가중치
        const weekendBoost = (dayOfWeek === 0 || dayOfWeek === 6) ? 1.4 : 1.0;
        const predictedVisitors = Math.max(0, Math.round((avgVisitors + trend * (i / 7)) * weekendBoost));
        forecast.push({
          day: date.toISOString().slice(0, 10),
          dayOfWeek: ['일','월','화','수','목','금','토'][dayOfWeek],
          predictedVisitors,
          predictedRevenue: predictedVisitors * TICKET_PRICE,
        });
      }
      result.forecast = forecast;
      result.forecastTotal = forecast.reduce((s, f) => s + f.predictedRevenue, 0);
      result.forecastTrend = trend > 0 ? 'up' : (trend < 0 ? 'down' : 'flat');
      result.forecastConfidence = last7Days.length >= 7 ? 'high' : 'low';
    }

    // ─── 3. 직원 효율 KPI ───
    const { data: calls } = await supabaseSvc
      .from('staff_calls')
      .select('*')
      .gte('called_at', monthAgo)
      .order('called_at', { ascending: false });

    // 직원별 통계
    const staffStats = {};
    (calls || []).forEach(c => {
      const id = c.staff_id || 'unknown';
      if (!staffStats[id]) {
        staffStats[id] = {
          staffId: id, name: c.staff_name || '직원',
          totalCalls: 0, urgentCalls: 0, smsSuccessCount: 0,
          totalDistance: 0, distanceCount: 0,
        };
      }
      staffStats[id].totalCalls++;
      if (c.urgency === 'urgent') staffStats[id].urgentCalls++;
      if (c.sms_sent) staffStats[id].smsSuccessCount++;
      if (c.distance_meters) {
        staffStats[id].totalDistance += c.distance_meters;
        staffStats[id].distanceCount++;
      }
    });

    result.staffKpi = Object.values(staffStats).map(s => ({
      ...s,
      avgDistance: s.distanceCount > 0 ? Math.round(s.totalDistance / s.distanceCount) : null,
      smsRate: s.totalCalls > 0 ? Math.round(s.smsSuccessCount / s.totalCalls * 100) : 0,
    })).sort((a, b) => b.totalCalls - a.totalCalls);

    // ─── 4. 종합 KPI ───
    result.overallKpi = {
      totalCalls: (calls || []).length,
      activeStaff: result.staffKpi.length,
      smsSuccessRate: result.staffKpi.reduce((s, x) => s + x.smsSuccessCount, 0) /
                      Math.max(1, result.staffKpi.reduce((s, x) => s + x.totalCalls, 0)) * 100,
      avgCallsPerStaff: result.staffKpi.length > 0
        ? Math.round((calls || []).length / result.staffKpi.length)
        : 0,
    };
    result.overallKpi.smsSuccessRate = Math.round(result.overallKpi.smsSuccessRate);

    res.status(200).json(result);
  } catch (e) {
    console.error('[forecast-kpi]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
