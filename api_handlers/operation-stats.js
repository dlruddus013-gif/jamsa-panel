// api/operation-stats.js
// 박물관 운영 통계 통합 API

import { supabaseSvc } from '../lib/auth.js';

const TICKET_PRICE = 5000; // 1인 5000원 가정

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const range = req.query.range || 'today';
    const result = {
      ok: true,
      range,
      generatedAt: new Date().toISOString(),
    };

    if (!supabaseSvc) {
      return res.status(200).json({ ok: true, fallback: true, ...result });
    }

    // 시간 범위 계산
    let startTime;
    if (range === 'today') {
      startTime = new Date(); startTime.setHours(0, 0, 0, 0);
    } else if (range === 'week') {
      startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    } else if (range === 'month') {
      startTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    } else {
      startTime = new Date(); startTime.setHours(0, 0, 0, 0);
    }
    const startISO = startTime.toISOString();

    // 1. 총 입장객 (RFID + QR 체크인 기반)
    const { data: checkins, error: e1 } = await supabaseSvc
      .from('visitor_checkins')
      .select('visitor_id, zone_id, zone_name, checked_in_at')
      .gte('checked_in_at', startISO)
      .order('checked_in_at', { ascending: true });

    if (e1) console.error('[op-stats] checkins:', e1);

    // 2. 인파 통계 (시간대별)
    const { data: crowdStats, error: e2 } = await supabaseSvc
      .from('zone_crowd_stats')
      .select('zone_id, people_count, recorded_at, crowd_level')
      .gte('recorded_at', startISO)
      .order('recorded_at', { ascending: true });

    if (e2) console.error('[op-stats] crowd:', e2);

    // 3. 입장객 분석
    const uniqueVisitors = new Set((checkins || []).map(c => c.visitor_id));
    result.totalVisitors = uniqueVisitors.size;
    result.totalCheckins = (checkins || []).length;
    result.estimatedRevenue = uniqueVisitors.size * TICKET_PRICE;

    // 4. 시간대별 입장 (9-18시, 1시간 단위)
    const hourly = new Array(10).fill(0);
    const visitorsByHour = {};
    (checkins || []).forEach(c => {
      const h = new Date(c.checked_in_at).getHours();
      if (h >= 9 && h <= 18) {
        if (!visitorsByHour[h]) visitorsByHour[h] = new Set();
        visitorsByHour[h].add(c.visitor_id);
      }
    });
    Object.entries(visitorsByHour).forEach(([h, set]) => {
      hourly[parseInt(h, 10) - 9] = set.size;
    });
    result.hourlyEntries = hourly;

    // 5. 피크 분석
    let peakHour = 0, peakCount = 0;
    hourly.forEach((c, i) => {
      if (c > peakCount) { peakCount = c; peakHour = 9 + i; }
    });
    result.peakHour = peakHour;
    result.peakCount = peakCount;
    result.peakTimeStr = peakHour > 0 ? `${peakHour}시 (${peakCount}명)` : '-';

    // 6. 동선 분석
    const visitorPaths = {};
    (checkins || []).forEach(c => {
      if (!visitorPaths[c.visitor_id]) visitorPaths[c.visitor_id] = [];
      visitorPaths[c.visitor_id].push({ zone: c.zone_id, name: c.zone_name, time: c.checked_in_at });
    });

    // 7. 인기 동선 (Top 10)
    const flowCounts = {};
    Object.values(visitorPaths).forEach(path => {
      for (let i = 0; i < path.length - 1; i++) {
        const key = `${path[i].zone}|${path[i+1].zone}`;
        if (!flowCounts[key]) flowCounts[key] = { from: path[i].zone, fromName: path[i].name, to: path[i+1].zone, toName: path[i+1].name, count: 0 };
        flowCounts[key].count++;
      }
    });
    result.topFlows = Object.values(flowCounts).sort((a, b) => b.count - a.count).slice(0, 10);

    // 8. 구역별 방문율
    const zoneCounts = {};
    (checkins || []).forEach(c => {
      if (!zoneCounts[c.zone_id]) zoneCounts[c.zone_id] = { zoneId: c.zone_id, zoneName: c.zone_name, count: 0, uniqueVisitors: new Set() };
      zoneCounts[c.zone_id].count++;
      zoneCounts[c.zone_id].uniqueVisitors.add(c.visitor_id);
    });
    result.zoneStats = Object.values(zoneCounts).map(z => ({
      zoneId: z.zoneId,
      zoneName: z.zoneName,
      checkins: z.count,
      uniqueVisitors: z.uniqueVisitors.size,
      visitRate: result.totalVisitors > 0 ? Math.round(z.uniqueVisitors.size / result.totalVisitors * 100) : 0,
    })).sort((a, b) => b.checkins - a.checkins);

    // 9. 평균 동선 길이 + 체류 시간
    const validPaths = Object.values(visitorPaths).filter(p => p.length >= 2);
    if (validPaths.length > 0) {
      const totalLen = validPaths.reduce((s, p) => s + p.length, 0);
      result.avgPathLength = (totalLen / validPaths.length).toFixed(1);
      const totalStay = validPaths.reduce((s, p) => {
        const start = new Date(p[0].time).getTime();
        const end = new Date(p[p.length - 1].time).getTime();
        return s + (end - start);
      }, 0);
      result.avgStayMinutes = Math.round(totalStay / validPaths.length / 60000);
    } else {
      result.avgPathLength = 0;
      result.avgStayMinutes = 0;
    }

    // 10. 만족도 추정 (동선 길이 + 체류 시간 기반 휴리스틱)
    if (result.avgPathLength > 0 && result.avgStayMinutes > 0) {
      // 길고 오래 있을수록 만족 (단순 휴리스틱)
      const lenScore = Math.min(50, result.avgPathLength * 8);
      const stayScore = Math.min(50, result.avgStayMinutes * 0.8);
      result.satisfactionScore = Math.round(lenScore + stayScore);
    } else {
      result.satisfactionScore = null;
    }

    // 11. CCTV AI 평균 인파 (모든 구역 평균)
    if (crowdStats && crowdStats.length > 0) {
      const avgPeople = crowdStats.reduce((s, c) => s + c.people_count, 0) / crowdStats.length;
      result.avgCctvPeople = avgPeople.toFixed(1);
      // 과밀 발생 횟수
      result.crowdedAlerts = crowdStats.filter(c => c.crowd_level === 'VERY_HIGH' || c.crowd_level === 'HIGH').length;
    }

    // 12. AI 권고사항 자동 생성
    const recommendations = [];
    if (result.satisfactionScore !== null) {
      if (result.satisfactionScore < 70) {
        recommendations.push(`만족도 ${result.satisfactionScore}점. 동선 안내 강화 또는 체험 프로그램 확대 권장.`);
      } else if (result.satisfactionScore >= 90) {
        recommendations.push(`만족도 ${result.satisfactionScore}점 - 우수. 현재 운영 방식 유지.`);
      }
    }
    if (peakCount > 0 && peakCount > result.totalVisitors / 3) {
      recommendations.push(`${peakHour}시 피크 (${peakCount}명) - 해당 시간 직원 추가 배치 권장.`);
    }
    const lowVisited = result.zoneStats.filter(z => z.visitRate < 20);
    if (lowVisited.length > 0) {
      recommendations.push(`사각지대 ${lowVisited.length}곳 (${lowVisited.slice(0,3).map(z => z.zoneName).join(', ')}) - 안내 강화 필요.`);
    }
    if (result.crowdedAlerts && result.crowdedAlerts > 5) {
      recommendations.push(`과밀 발생 ${result.crowdedAlerts}회 - 입장 제한 또는 분산 안내 시스템 가동 권장.`);
    }
    if (recommendations.length === 0) {
      recommendations.push('현재 운영 데이터 정상. 모니터링 지속.');
    }
    result.recommendations = recommendations;

    res.status(200).json(result);
  } catch (e) {
    console.error('[op-stats]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
