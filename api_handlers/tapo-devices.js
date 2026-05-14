// api/tapo-devices.js
// Tapo 기기 통합 관리 API (Phase 1)
// GET / POST / PATCH / DELETE 통합 처리

import { supabaseSvc } from '../lib/auth.js';

const VALID_CATEGORIES = [
  'camera', 'doorbell', 'chime',
  'plug', 'power_strip', 'energy_meter',
  'light', 'switch',
  'motion_sensor', 'contact_sensor', 'temperature_sensor',
  'humidity_sensor', 'water_leak_sensor', 'button',
  'hub', 'ir_remote', 'robot_vacuum',
];

const CATEGORY_ICONS = {
  camera: '📹', doorbell: '🔔', chime: '🎵',
  plug: '🔌', power_strip: '🔌', energy_meter: '⚡',
  light: '💡', switch: '🎚️',
  motion_sensor: '🚶', contact_sensor: '🚪', temperature_sensor: '🌡️',
  humidity_sensor: '💧', water_leak_sensor: '💦', button: '🔘',
  hub: '📡', ir_remote: '📡', robot_vacuum: '🤖',
};

const CATEGORY_COLORS = {
  camera: '#dc2626', doorbell: '#dc2626', chime: '#dc2626',
  plug: '#f59e0b', power_strip: '#f59e0b', energy_meter: '#f59e0b',
  light: '#fbbf24', switch: '#fbbf24',
  motion_sensor: '#3b82f6', contact_sensor: '#3b82f6',
  temperature_sensor: '#06b6d4', humidity_sensor: '#06b6d4',
  water_leak_sensor: '#0ea5e9', button: '#8b5cf6',
  hub: '#7c3aed', ir_remote: '#7c3aed', robot_vacuum: '#10b981',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabaseSvc) {
    return res.status(200).json({ ok: true, fallback: true, devices: [] });
  }

  try {
    // ─── GET: 기기 목록 조회 ───
    if (req.method === 'GET') {
      const { id, zone, category, online } = req.query;

      // 단일 기기 조회
      if (id) {
        const { data: device, error } = await supabaseSvc
          .from('tapo_devices').select('*').eq('id', id).single();
        if (error) throw error;
        // 최근 상태도 같이
        const { data: state } = await supabaseSvc
          .from('tapo_device_states').select('*').eq('device_id', id)
          .order('updated_at', { ascending: false }).limit(1).single();
        return res.status(200).json({ ok: true, device, state });
      }

      // 전체/필터 조회
      let q = supabaseSvc.from('tapo_devices').select('*').order('created_at', { ascending: false });
      if (zone) q = q.eq('zone_id', zone);
      if (category) q = q.eq('category', category);
      const { data: devices, error } = await q;
      if (error) throw error;

      // 모든 기기의 최근 상태도 한 번에 조회
      const deviceIds = (devices || []).map(d => d.id);
      let states = [];
      if (deviceIds.length > 0) {
        // 가장 최근 상태만 (5분 이내)
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data: stateData } = await supabaseSvc
          .from('tapo_device_states')
          .select('*')
          .in('device_id', deviceIds)
          .gte('updated_at', fiveMinAgo)
          .order('updated_at', { ascending: false });
        states = stateData || [];
      }
      // 기기별 최근 상태 매핑
      const stateMap = {};
      states.forEach(s => {
        if (!stateMap[s.device_id]) stateMap[s.device_id] = s;
      });

      // 카테고리 메타 추가
      const enrichedDevices = (devices || []).map(d => ({
        ...d,
        icon: CATEGORY_ICONS[d.category] || '📦',
        color: CATEGORY_COLORS[d.category] || '#64748b',
        currentState: stateMap[d.id] || null,
        isOnline: stateMap[d.id]?.online || false,
      }));

      // online 필터 (메모리에서)
      const filtered = online !== undefined
        ? enrichedDevices.filter(d => d.isOnline === (online === 'true'))
        : enrichedDevices;

      // 통계
      const stats = {
        total: filtered.length,
        online: filtered.filter(d => d.isOnline).length,
        byCategory: {},
        byZone: {},
      };
      filtered.forEach(d => {
        stats.byCategory[d.category] = (stats.byCategory[d.category] || 0) + 1;
        if (d.zone_id) stats.byZone[d.zone_id] = (stats.byZone[d.zone_id] || 0) + 1;
      });

      return res.status(200).json({ ok: true, devices: filtered, stats });
    }

    // ─── POST: 기기 등록 또는 상태 갱신 ───
    if (req.method === 'POST') {
      // /:id/status 엔드포인트 처리 (URL 분기)
      const url = new URL(req.url || '', 'http://localhost');
      const pathParts = url.pathname.split('/').filter(Boolean);
      // 예: /api/tapo-devices?id=xxx&action=status

      // ─── Phase 4-B/C: 플러그/조명/센서 통합 액션 ───
      const { id: queryId, action: queryAction } = req.query;
      
      if (queryId && queryAction) {
        // 기기 조회
        const { data: dev } = await supabaseSvc.from('tapo_devices').select('*').eq('id', queryId).single();
        if (!dev) return res.status(404).json({ error: 'device_not_found' });

        // Generic command queue for bridge/Home Assistant/Tapo worker.
        // The museum PC bridge can poll tapo_device_events and execute these actions locally.
        const genericActions = [
          'command', 'snapshot', 'start_recording', 'stop_recording',
          'turn_on', 'turn_off', 'set_brightness', 'set_color_temp',
          'set_mode', 'siren_on', 'siren_off'
        ];
        if (genericActions.includes(queryAction)) {
          const body = req.body || {};
          const command = body.command || queryAction;
          const payload = {
            command,
            params: body,
            requested_at: new Date().toISOString(),
          };
          const nextState = { ...(dev.current_state || {}) };
          if (command === 'turn_on') nextState.power = 'ON';
          if (command === 'turn_off') nextState.power = 'OFF';
          if (command === 'set_brightness' && body.brightness != null) nextState.brightness = Number(body.brightness);
          if (command === 'set_color_temp' && body.colorTemp != null) nextState.color_temp = Number(body.colorTemp);

          const { data: event, error } = await supabaseSvc.from('tapo_device_events').insert({
            device_id: queryId,
            zone: dev.zone_id,
            event_type: 'iot_command',
            severity: command === 'turn_off' || command === 'start_recording' ? 'warning' : 'normal',
            title: `IoT 명령: ${command}`,
            description: `${dev.name || queryId} ${command} 명령 대기열 등록`,
            raw_payload: payload,
            confirmed: false,
            created_at: new Date().toISOString(),
          }).select().single();
          if (error) throw error;
          await supabaseSvc.from('tapo_devices')
            .update({ current_state: nextState, updated_at: new Date().toISOString() })
            .eq('id', queryId);
          return res.status(200).json({ ok: true, queued: true, command, command_id: event?.id, state: nextState });
        }

        // 전원 토글 (플러그/조명)
        if (queryAction === 'power_toggle') {
          const cur = dev.current_state?.power === 'ON';
          const newState = { ...(dev.current_state || {}), power: cur ? 'OFF' : 'ON' };
          await supabaseSvc.from('tapo_devices').update({ current_state: newState, updated_at: new Date().toISOString() }).eq('id', queryId);
          await supabaseSvc.from('tapo_device_events').insert({
            device_id: queryId, zone: dev.zone_id,
            event_type: 'power_toggle', severity: 'normal',
            title: cur ? '🔴 전원 OFF' : '🟢 전원 ON',
            description: `${dev.name} 전원 ${cur ? '꺼짐' : '켜짐'}`,
            raw_payload: { from: cur ? 'ON' : 'OFF', to: cur ? 'OFF' : 'ON' },
            created_at: new Date().toISOString(),
          });
          return res.status(200).json({ ok: true, power: cur ? 'OFF' : 'ON' });
        }

        // 일정 ON/OFF 시간 설정
        if (queryAction === 'schedule_on' || queryAction === 'schedule_off') {
          const field = queryAction === 'schedule_on' ? 'schedule_on' : 'schedule_off';
          await supabaseSvc.from('tapo_devices').update({ [field]: req.query.time, updated_at: new Date().toISOString() }).eq('id', queryId);
          return res.status(200).json({ ok: true, [field]: req.query.time });
        }

        // 타이머 설정 (X분 후 OFF)
        if (queryAction === 'timer') {
          const minutes = parseInt(req.query.minutes) || 0;
          const offAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
          await supabaseSvc.from('tapo_devices').update({ timer_off_at: offAt, updated_at: new Date().toISOString() }).eq('id', queryId);
          await supabaseSvc.from('tapo_device_events').insert({
            device_id: queryId, zone: dev.zone_id,
            event_type: 'timer_set', severity: 'normal',
            title: `⏲️ ${minutes}분 타이머 설정`,
            description: `${minutes}분 후 자동 OFF`,
            raw_payload: { minutes, off_at: offAt },
            created_at: new Date().toISOString(),
          });
          return res.status(200).json({ ok: true, off_at: offAt });
        }

        // 밝기 / 색온도 (조명)
        if (queryAction === 'brightness' || queryAction === 'color_temp') {
          const val = parseInt(req.query.value) || 0;
          const field = queryAction === 'brightness' ? 'brightness' : 'color_temp';
          await supabaseSvc.from('tapo_devices').update({ [field]: val, updated_at: new Date().toISOString() }).eq('id', queryId);
          return res.status(200).json({ ok: true, [field]: val });
        }

        // 센서 임계값 설정
        if (queryAction === 'threshold') {
          const type = req.query.type;
          const val = parseFloat(req.query.value);
          const thresholds = dev.thresholds || {};
          thresholds[type] = val;
          await supabaseSvc.from('tapo_devices').update({ thresholds, updated_at: new Date().toISOString() }).eq('id', queryId);
          return res.status(200).json({ ok: true, thresholds });
        }
      }

      if (req.query.action === 'status') {
        const deviceId = req.query.id;
        if (!deviceId) return res.status(400).json({ error: 'missing_device_id' });

        const stateRecord = {
          device_id: deviceId,
          online: req.body?.online ?? false,
          power: req.body?.power || null,
          battery_level: req.body?.batteryLevel ?? null,
          temperature: req.body?.temperature ?? null,
          humidity: req.body?.humidity ?? null,
          motion: req.body?.motion ?? null,
          contact: req.body?.contact || null,
          energy_watt: req.body?.energyWatt ?? null,
          camera_stream_status: req.body?.cameraStreamStatus || null,
          raw_data: req.body?.raw || null,
          updated_at: new Date().toISOString(),
        };

        const { error } = await supabaseSvc.from('tapo_device_states').insert(stateRecord);
        if (error) throw error;
        return res.status(200).json({ ok: true, updated: true });
      }

      if (req.query.action === 'event') {
        const deviceId = req.query.id;
        const { type, severity = 'normal', title, description, rawPayload } = req.body || {};
        const eventRecord = {
          device_id: deviceId,
          zone: req.body?.zone || null,
          event_type: type,
          severity,
          title: title || `${type} 이벤트`,
          description: description || '',
          raw_payload: rawPayload || null,
          created_at: new Date().toISOString(),
        };
        const { data: event, error } = await supabaseSvc
          .from('tapo_device_events').insert(eventRecord).select().single();
        if (error) throw error;
        return res.status(200).json({ ok: true, event });
      }

      // 기기 신규 등록
      const {
        name, category, zoneId, model,
        ip, port, rtspUrl, onvifUrl,
        username, password, // 암호화 권장 (현재는 평문)
        haEntityId, matterNodeId, hubId,
        latitude, longitude,
        x, y, // 지도 좌표 (% 단위)
        notes,
      } = req.body || {};

      if (!name || !category) {
        return res.status(400).json({ error: 'missing_required_fields', required: ['name', 'category'] });
      }
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'invalid_category', valid: VALID_CATEGORIES });
      }

      const deviceRecord = {
        name, category, zone_id: zoneId || null,
        model: model || null,
        ip: ip || null, port: port || null,
        rtsp_url: rtspUrl || null, onvif_url: onvifUrl || null,
        username: username || null, password: password || null,
        ha_entity_id: haEntityId || null,
        matter_node_id: matterNodeId || null,
        hub_id: hubId || null,
        latitude: latitude || null, longitude: longitude || null,
        x: x || null, y: y || null,
        notes: notes || null,
        created_at: new Date().toISOString(),
      };

      const { data: device, error } = await supabaseSvc
        .from('tapo_devices').insert(deviceRecord).select().single();
      if (error) throw error;
      return res.status(200).json({ ok: true, device });
    }

    // ─── PATCH: 기기 수정 ───
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'missing_id' });

      const { data: device, error } = await supabaseSvc
        .from('tapo_devices')
        .update({ ...req.body, updated_at: new Date().toISOString() })
        .eq('id', id).select().single();
      if (error) throw error;
      return res.status(200).json({ ok: true, device });
    }

    // ─── DELETE: 기기 삭제 ───
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'missing_id' });

      const { error } = await supabaseSvc.from('tapo_devices').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true, deleted: true });
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[tapo-devices]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
