// api/qr-checkin.js
// 관람객 QR 체크인 (구역 입장)

import { supabaseSvc } from '../lib/auth.js';

function isMissingTable(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes("could not find the table") || msg.includes("schema cache") || (msg.includes("relation") && msg.includes("does not exist"));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    // 체크인 기록
    try {
      const { visitorId, zoneId, zoneName, checkpointType } = req.body || {};
      if (!visitorId || !zoneId) {
        return res.status(400).json({ error: 'missing_fields' });
      }
      const record = {
        visitor_id: visitorId,
        zone_id: zoneId,
        zone_name: zoneName || zoneId,
        checkpoint_type: checkpointType || 'entry', // entry | exit | experience
        checked_in_at: new Date().toISOString(),
      };
      if (supabaseSvc) {
        const { error } = await supabaseSvc.from('visitor_checkins').insert(record);
        if (error) console.error('[qr-checkin]', error);
      }
      res.status(200).json({
        ok: true,
        message: `${zoneName || zoneId} 체크인 완료`,
        checkpointType: record.checkpoint_type,
      });
    } catch (e) {
      if (isMissingTable(e)) return res.status(200).json({ ok: true, fallback: true, hint: 'visitor_checkins 테이블 미생성' });
      res.status(500).json({ error: 'internal_error', message: e.message });
    }
    return;
  }

  if (req.method === 'GET') {
    // 동선 조회
    try {
      if (!supabaseSvc) return res.status(200).json({ ok: true, checkins: [] });

      const visitorId = req.query.visitor;
      const range = req.query.range || 'today';

      let q = supabaseSvc
        .from('visitor_checkins')
        .select('*')
        .order('checked_in_at', { ascending: true });

      if (visitorId) q = q.eq('visitor_id', visitorId);

      if (range === 'today') {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        q = q.gte('checked_in_at', todayStart.toISOString());
      } else if (range === 'week') {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        q = q.gte('checked_in_at', weekAgo);
      }

      const { data, error } = await q;
      if (error) throw error;

      // 구역간 이동 패턴 분석
      const transitions = {}; // "zoneA → zoneB": count
      const visitorPaths = {}; // visitorId: [zoneA, zoneB, zoneC]
      (data || []).forEach(r => {
        if (!visitorPaths[r.visitor_id]) visitorPaths[r.visitor_id] = [];
        visitorPaths[r.visitor_id].push(r.zone_id);
      });
      Object.values(visitorPaths).forEach(path => {
        for (let i = 0; i < path.length - 1; i++) {
          const key = `${path[i]} → ${path[i + 1]}`;
          transitions[key] = (transitions[key] || 0) + 1;
        }
      });

      res.status(200).json({
        ok: true,
        checkins: data || [],
        totalVisitors: Object.keys(visitorPaths).length,
        transitions,
        topTransitions: Object.entries(transitions)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([path, count]) => ({ path, count })),
      });
    } catch (e) {
      if (isMissingTable(e)) {
        return res.status(200).json({ ok: true, fallback: true, checkins: [], totalVisitors: 0, transitions: {}, topTransitions: [], hint: 'visitor_checkins 테이블 미생성' });
      }
      res.status(500).json({ error: 'internal_error', message: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
