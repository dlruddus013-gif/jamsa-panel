// api/staff-locations.js
// 현재 활성화된 모든 사용자 위치를 조회 (통합지도 표시용)

import { supabaseSvc } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    if (!supabaseSvc) {
      return res.status(200).json({ ok: true, users: [], note: 'no_supabase' });
    }

    // 최근 5분 내 업데이트된 위치만 (오프라인은 자동 제외)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await supabaseSvc
      .from('staff_locations')
      .select('*')
      .gte('updated_at', fiveMinAgo)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[locations] Supabase 에러:', error);
      return res.status(200).json({ ok: true, users: [], error: error.message });
    }

    // 클라이언트에 보낼 깔끔한 데이터로 변환
    const users = (data || []).map(r => ({
      id: r.id,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      accuracy: r.accuracy,
      source: r.source, // gps | wifi | beacon
      role: r.role || 'staff', // staff | visitor
      dept: r.dept,
      beaconName: r.beacon_name,
      lastSeen: r.last_seen,
      updatedAt: r.updated_at,
      // 마지막 업데이트로부터 경과 초
      ageSec: Math.floor((Date.now() - new Date(r.updated_at).getTime()) / 1000),
    }));

    res.status(200).json({ ok: true, users, count: users.length });
  } catch (e) {
    console.error('[locations] 에러:', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
