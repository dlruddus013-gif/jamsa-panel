// api/staff-dispatch.js
// 직원 호출: 위치 기반으로 가장 가까운 직원 자동 선택 + SMS 발송

import { supabaseSvc } from '../lib/auth.js';

const PPURIO_USERNAME = process.env.PPURIO_USERNAME;
const PPURIO_API_KEY = process.env.PPURIO_API_KEY;
const PPURIO_SENDER = process.env.PPURIO_SENDER;

let ppurioTokenCache = null;
let ppurioTokenExpiry = 0;

async function getPpurioToken() {
  if (ppurioTokenCache && Date.now() < ppurioTokenExpiry) return ppurioTokenCache;
  if (!PPURIO_USERNAME || !PPURIO_API_KEY) return null;
  try {
    const auth = Buffer.from(`${PPURIO_USERNAME}:${PPURIO_API_KEY}`).toString('base64');
    const res = await fetch('https://message.ppurio.com/v1/token', {
      method: 'POST', headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    ppurioTokenCache = data.token;
    ppurioTokenExpiry = Date.now() + (data.expired_in - 60) * 1000;
    return ppurioTokenCache;
  } catch (e) { return null; }
}

async function sendSms(token, to, message) {
  if (!token || !PPURIO_SENDER || !to) return { ok: false };
  try {
    const res = await fetch('https://message.ppurio.com/v1/message', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: PPURIO_USERNAME, messageType: 'SMS',
        from: PPURIO_SENDER, content: message.slice(0, 90),
        targetCount: 1, targets: [{ to: to.replace(/[^0-9]/g, '') }],
      }),
    });
    return { ok: res.ok };
  } catch (e) { return { ok: false }; }
}

// 두 위경도 사이 거리 (m)
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180, Δλ = (lng2-lng1) * Math.PI/180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const { targetLat, targetLng, zoneId, zoneName, message, count = 1, urgency = 'normal' } = req.body || {};

    if (!supabaseSvc) {
      return res.status(200).json({ ok: false, reason: 'no_supabase', dispatched: [] });
    }

    // 활성 직원 위치 조회 (5분 이내)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: locations, error } = await supabaseSvc
      .from('staff_locations')
      .select('*')
      .gte('updated_at', fiveMinAgo)
      .eq('role', 'staff');
    if (error) throw error;

    let candidates = locations || [];

    // 거리 계산 (targetLat/Lng 있으면)
    if (targetLat && targetLng) {
      candidates = candidates.map(s => ({
        ...s,
        distance: haversine(s.lat, s.lng, targetLat, targetLng),
      })).sort((a, b) => a.distance - b.distance);
    }

    // 상위 N명 선택
    const selected = candidates.slice(0, count);

    if (selected.length === 0) {
      return res.status(200).json({
        ok: false, reason: 'no_active_staff',
        message: '현재 활성화된 직원 위치 정보가 없습니다',
      });
    }

    // SMS 발송
    const token = await getPpurioToken();
    const dispatched = [];
    for (const staff of selected) {
      const phone = staff.phone || staff.user_phone;
      const name = staff.user_name || staff.name || '직원';
      const distMeter = staff.distance ? Math.round(staff.distance) : null;
      const urgencyLabel = urgency === 'urgent' ? '🚨긴급' : urgency === 'high' ? '⚠️중요' : '📞호출';
      const smsMsg = `[${urgencyLabel}] ${zoneName || '구역'} ${message || '직원 호출'} ${distMeter ? `(현재 위치 ${distMeter}m)` : ''}`;

      let smsResult = { ok: false };
      if (token && phone) {
        smsResult = await sendSms(token, phone, smsMsg);
        await new Promise(r => setTimeout(r, 100));
      }

      dispatched.push({
        staffId: staff.user_id || staff.id,
        name, phone, distance: distMeter,
        smsOk: smsResult.ok,
      });

      // 호출 이력 저장
      await supabaseSvc.from('staff_calls').insert({
        staff_id: staff.user_id || staff.id,
        staff_name: name,
        zone_id: zoneId || null,
        zone_name: zoneName || null,
        message: message || '호출',
        urgency,
        distance_meters: distMeter,
        sms_sent: smsResult.ok,
        called_at: new Date().toISOString(),
      }).then(() => {}).catch(() => {});
    }

    res.status(200).json({
      ok: true, dispatched, count: dispatched.length,
      smsConfigured: !!(PPURIO_USERNAME && PPURIO_API_KEY && PPURIO_SENDER),
    });
  } catch (e) {
    console.error('[staff-dispatch]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
