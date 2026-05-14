// api/zone-crowd-stats.js
// 구역별 인파 통계 저장 + 조회

import { supabaseSvc } from '../lib/auth.js';

// Supabase 테이블 누락 등 "스키마 캐시" 에러 감지 헬퍼
function isMissingTable(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes("could not find the table") || msg.includes("schema cache") || msg.includes("relation") && msg.includes("does not exist");
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    // CCTV AI 분석 결과 저장
    try {
      const { zoneId, channelCh, peopleCount, confidence, crowdLevel, source } = req.body || {};
      if (!zoneId || peopleCount === undefined) {
        return res.status(400).json({ error: 'missing_fields' });
      }
      const record = {
        zone_id: zoneId,
        channel_ch: channelCh || null,
        people_count: parseInt(peopleCount, 10) || 0,
        confidence: parseFloat(confidence) || 0,
        crowd_level: crowdLevel || 'UNKNOWN',
        source: source || 'cctv_ai',
        recorded_at: new Date().toISOString(),
      };
      if (supabaseSvc) {
        const { error } = await supabaseSvc.from('zone_crowd_stats').insert(record);
        if (error) console.error('[crowd-stats]', error);
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      // 테이블 없으면 graceful (POST는 fire-and-forget 성격)
      if (isMissingTable(e)) return res.status(200).json({ ok: true, fallback: true, hint: 'zone_crowd_stats 테이블 미생성' });
      res.status(500).json({ error: 'internal_error', message: e.message });
    }
    return;
  }

  if (req.method === 'GET') {
    // 최근 인파 통계 조회 (구역별 가장 최근 + 시간대별)
    try {
      if (!supabaseSvc) return res.status(200).json({ ok: true, currentByZone: {}, history: [] });

      const range = req.query.range || 'now'; // now | day | week
      const zoneId = req.query.zone;

      if (range === 'now') {
        // 각 구역별 가장 최근 5분 데이터
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data, error } = await supabaseSvc
          .from('zone_crowd_stats')
          .select('*')
          .gte('recorded_at', fiveMinAgo)
          .order('recorded_at', { ascending: false });

        if (error) throw error;

        // 구역별 가장 최근 값만
        const currentByZone = {};
        (data || []).forEach(r => {
          if (!currentByZone[r.zone_id] || new Date(r.recorded_at) > new Date(currentByZone[r.zone_id].recorded_at)) {
            currentByZone[r.zone_id] = r;
          }
        });

        res.status(200).json({ ok: true, currentByZone, count: Object.keys(currentByZone).length });
      } else if (range === 'day') {
        // 오늘 시간대별 (1시간 단위)
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        let q = supabaseSvc
          .from('zone_crowd_stats')
          .select('*')
          .gte('recorded_at', todayStart.toISOString())
          .order('recorded_at', { ascending: true });
        if (zoneId) q = q.eq('zone_id', zoneId);
        const { data, error } = await q;
        if (error) throw error;

        // 시간대별 평균 계산
        const byHour = {};
        (data || []).forEach(r => {
          const h = new Date(r.recorded_at).getHours();
          const key = `${r.zone_id}|${h}`;
          if (!byHour[key]) byHour[key] = { zoneId: r.zone_id, hour: h, total: 0, count: 0 };
          byHour[key].total += r.people_count;
          byHour[key].count++;
        });
        const hourly = Object.values(byHour).map(b => ({
          zoneId: b.zoneId, hour: b.hour, avg: Math.round(b.total / b.count),
        }));
        res.status(200).json({ ok: true, hourly });
      } else if (range === 'week') {
        // 지난 7일
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        let q = supabaseSvc
          .from('zone_crowd_stats')
          .select('*')
          .gte('recorded_at', weekAgo)
          .order('recorded_at', { ascending: true });
        if (zoneId) q = q.eq('zone_id', zoneId);
        const { data, error } = await q;
        if (error) throw error;

        // 일별 평균
        const byDay = {};
        (data || []).forEach(r => {
          const day = r.recorded_at.slice(0, 10);
          const key = `${r.zone_id}|${day}`;
          if (!byDay[key]) byDay[key] = { zoneId: r.zone_id, day, total: 0, count: 0, peak: 0 };
          byDay[key].total += r.people_count;
          byDay[key].count++;
          byDay[key].peak = Math.max(byDay[key].peak, r.people_count);
        });
        const daily = Object.values(byDay).map(b => ({
          zoneId: b.zoneId, day: b.day,
          avg: Math.round(b.total / b.count),
          peak: b.peak,
        }));
        res.status(200).json({ ok: true, daily });
      }
    } catch (e) {
      console.error('[crowd-stats GET]', e);
      // 테이블 없으면 빈 데이터 반환 (UI가 정상 작동하도록)
      if (isMissingTable(e)) {
        return res.status(200).json({ ok: true, fallback: true, currentByZone: {}, hourly: [], daily: [], hint: 'zone_crowd_stats 테이블 미생성 - Supabase 마이그레이션 필요' });
      }
      res.status(500).json({ error: 'internal_error', message: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
