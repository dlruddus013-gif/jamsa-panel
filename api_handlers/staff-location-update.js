// api/staff-location-update.js
// 사용자 위치 업데이트 (직원/관람객 통합)

import { supabaseSvc } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const {
      staffId, staffName, lat, lng, accuracy,
      source, beaconId, beaconName, timestamp,
      role, dept,
    } = req.body || {};

    if (!staffId || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'missing_input' });
    }

    const record = {
      id: staffId,
      name: staffName || '익명',
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      accuracy: parseFloat(accuracy) || null,
      source: source || 'gps',
      beacon_id: beaconId || null,
      beacon_name: beaconName || null,
      role: role || 'staff',
      dept: dept || null,
      last_seen: timestamp || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (supabaseSvc) {
      const { error } = await supabaseSvc
        .from('staff_locations')
        .upsert(record, { onConflict: 'id' });
      if (error) {
        console.error('[location-update] Supabase:', error);
        return res.status(200).json({ ok: true, warning: 'db_save_failed', error: error.message });
      }
    }
    res.status(200).json({ ok: true, recorded: record });
  } catch (e) {
    console.error('[location-update]:', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
