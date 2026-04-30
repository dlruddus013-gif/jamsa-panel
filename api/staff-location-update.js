// api/staff-location-update.js
// 직원 PWA에서 보내는 위치 정보를 Supabase에 저장

import { supabaseSvc } from '../lib/auth.js';

export default async function handler(req, res) {
  // CORS 허용 (다른 도메인의 PWA에서도 호출 가능)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const { 
      staffId, staffName, lat, lng, accuracy, 
      source, beaconId, beaconName, timestamp 
    } = req.body || {};

    if (!staffId || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'missing_input' });
    }

    const record = {
      id: staffId,
      name: staffName,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      accuracy: parseFloat(accuracy) || null,
      source: source || 'unknown', // gps | beacon | wifi
      beacon_id: beaconId || null,
      beacon_name: beaconName || null,
      last_seen: timestamp || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (supabaseSvc) {
      // Upsert: 없으면 INSERT, 있으면 UPDATE
      const { error } = await supabaseSvc
        .from('staff_locations')
        .upsert(record, { onConflict: 'id' });
      
      if (error) {
        console.error('[location-update] Supabase 에러:', error);
        // Supabase 에러여도 200 응답 (PWA에서 재시도 가능)
        return res.status(200).json({ ok: true, warning: 'db_save_failed', error: error.message });
      }
    }

    res.status(200).json({ ok: true, recorded: record });
  } catch (e) {
    console.error('[location-update] 에러:', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
