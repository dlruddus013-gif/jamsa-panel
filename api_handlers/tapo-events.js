// api/tapo-events.js
// Tapo 이벤트 통합 API - 조회 + 안전관리 자동 전환

import { supabaseSvc } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabaseSvc) {
    return res.status(200).json({ ok: true, fallback: true, events: [] });
  }

  try {
    // ─── GET: 이벤트 목록 ───
    if (req.method === 'GET') {
      const { range = 'today', severity, deviceId, limit = 50, since_id, event_type, pending } = req.query;

      let q = supabaseSvc
        .from('tapo_device_events')
        .select('*, tapo_devices(name, category, zone_id, ip)')
        .order('created_at', { ascending: false })
        .limit(parseInt(limit, 10));

      // Phase 5: 박물관 PC 폴링 모드 (since_id 이후 이벤트만)
      if (since_id) {
        q = supabaseSvc
          .from('tapo_device_events')
          .select('*, tapo_devices(name, category, zone_id, ip)')
          .gt('id', parseInt(since_id, 10))
          .order('id', { ascending: true })
          .limit(parseInt(limit, 10));
      }
      
      // pending=1: 아직 확인되지 않은 명령만
      if (pending) {
        q = q.eq('confirmed', false);
      }
      
      // event_type 필터
      if (event_type) {
        q = q.eq('event_type', event_type);
      }

      if (range === 'today' && !since_id) {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        q = q.gte('created_at', todayStart.toISOString());
      } else if (range === 'week' && !since_id) {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        q = q.gte('created_at', weekAgo);
      } else if (range === 'month' && !since_id) {
        const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        q = q.gte('created_at', monthAgo);
      }

      if (severity) q = q.eq('severity', severity);
      if (deviceId) q = q.eq('device_id', deviceId);

      const { data, error } = await q;
      if (error) throw error;
      
      // device 정보를 raw event에 합쳐서 반환 (Phase 5 호환)
      const enriched = (data || []).map(e => ({
        ...e,
        device: e.tapo_devices || null,
      }));

      // 통계
      const stats = {
        total: enriched.length,
        bySeverity: { normal: 0, caution: 0, danger: 0 },
        byType: {},
        unconfirmed: 0,
      };
      enriched.forEach(e => {
        stats.bySeverity[e.severity] = (stats.bySeverity[e.severity] || 0) + 1;
        stats.byType[e.event_type] = (stats.byType[e.event_type] || 0) + 1;
        if (!e.confirmed) stats.unconfirmed++;
      });

      return res.status(200).json({ ok: true, events: enriched, stats });
    }

    // ─── POST: 이벤트 등록 (외부 시스템에서 트리거) ───
    if (req.method === 'POST') {
      const { deviceId, type, severity = 'normal', title, description, rawPayload, autoIncident } = req.body || {};
      if (!deviceId || !type) return res.status(400).json({ error: 'missing_required' });

      // 기기 정보 가져오기
      const { data: device } = await supabaseSvc
        .from('tapo_devices').select('name, zone_id, category').eq('id', deviceId).single();

      const eventRecord = {
        device_id: deviceId,
        zone: device?.zone_id || null,
        event_type: type,
        severity,
        title: title || `${device?.name || deviceId} ${type}`,
        description: description || '',
        raw_payload: rawPayload || null,
        confirmed: false,
        created_at: new Date().toISOString(),
      };

      const { data: event, error } = await supabaseSvc
        .from('tapo_device_events').insert(eventRecord).select().single();
      if (error) throw error;

      // ─── 안전관리 자동 전환 (severity=danger 또는 autoIncident=true) ───
      let incidentId = null;
      if (severity === 'danger' || autoIncident) {
        // auto_alerts에도 기록 (기존 자동 알림 시스템과 통합)
        const alertRecord = {
          alert_type: type,
          zone_id: device?.zone_id || null,
          zone_name: device?.zone_id || null,
          severity: severity === 'danger' ? 'DANGER' : 'WARNING',
          message: `Tapo ${device?.name || deviceId}: ${title || type}`,
          channel_ch: null,
          people_count: null,
          auto_called: false,
          recipients: [],
          created_at: new Date().toISOString(),
        };
        const { data: alert } = await supabaseSvc
          .from('auto_alerts').insert(alertRecord).select('id').single();
        incidentId = alert?.id;
      }

      return res.status(200).json({ ok: true, event, incidentId, autoConverted: !!incidentId });
    }

    // ─── PATCH: 이벤트 확인 처리 ───
    if (req.method === 'PATCH') {
      const { id, confirmed = true } = req.body || {};
      if (!id) return res.status(400).json({ error: 'missing_id' });

      const { data: event, error } = await supabaseSvc
        .from('tapo_device_events')
        .update({ confirmed, confirmed_at: confirmed ? new Date().toISOString() : null })
        .eq('id', id).select().single();
      if (error) throw error;

      return res.status(200).json({ ok: true, event });
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[tapo-events]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
