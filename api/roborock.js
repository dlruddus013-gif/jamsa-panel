// api/roborock.js
// Roborock 로봇청소기 명령 큐잉 + 상태 관리

import { supabaseSvc } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabaseSvc) {
    return res.status(200).json({ ok: true, fallback: true });
  }

  try {
    const { id, action } = req.query;
    if (!id) return res.status(400).json({ error: 'missing_device_id' });

    // 기기 조회 (로보락은 robot_vacuum 카테고리)
    const { data: device, error: devErr } = await supabaseSvc
      .from('tapo_devices').select('*').eq('id', id).single();
    if (devErr || !device) return res.status(404).json({ error: 'device_not_found' });
    if (device.category !== 'robot_vacuum') {
      return res.status(400).json({ error: 'not_a_robot_vacuum' });
    }

    // ─── GET: 상태 조회 ───
    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        device: device,
        state: device.current_state || {},
      });
    }

    // ─── POST: 명령 실행 (박물관 PC가 폴링하여 처리) ───
    if (req.method === 'POST') {
      const validActions = ['start', 'pause', 'stop', 'return_home', 'find_robot', 
                           'set_fan_speed', 'clean_zone', 'clean_segment',
                           'set_schedule', 'reset_consumable'];
      if (!validActions.includes(action)) {
        return res.status(400).json({ error: 'invalid_action', valid: validActions });
      }

      const payload = {
        command: action,
        ...(req.query.speed && { speed: req.query.speed }),
        ...(req.query.zone && { zone: req.query.zone }),
        ...(req.query.segment_id && { segment_id: req.query.segment_id }),
        ...(req.query.time && { schedule_time: req.query.time }),
        ...(req.query.consumable && { consumable: req.query.consumable }),
        queued_at: new Date().toISOString(),
      };

      // 명령을 events에 저장 (박물관 PC가 폴링하여 실행)
      const { data: event, error } = await supabaseSvc.from('tapo_device_events').insert({
        device_id: id,
        zone: device.zone_id,
        event_type: 'roborock_command',
        severity: action === 'stop' ? 'warning' : 'normal',
        title: `🤖 ${getActionTitle(action)}`,
        description: getActionDescription(action, payload),
        raw_payload: payload,
        confirmed: false,
        created_at: new Date().toISOString(),
      }).select().single();

      if (error) {
        console.error('[roborock]', error);
        return res.status(500).json({ error: 'queue_failed' });
      }

      // 로컬 상태 즉시 업데이트 (UI 반응성)
      let newState = { ...(device.current_state || {}) };
      if (action === 'start') newState.state = 'cleaning';
      if (action === 'pause') newState.state = 'paused';
      if (action === 'stop') newState.state = 'docked';
      if (action === 'return_home') newState.state = 'returning';
      if (action === 'set_fan_speed') newState.fan_speed = payload.speed;

      await supabaseSvc.from('tapo_devices')
        .update({ current_state: newState, updated_at: new Date().toISOString() })
        .eq('id', id);

      return res.status(200).json({
        ok: true, queued: true, command_id: event.id,
        action, payload, message: '박물관 PC에서 곧 처리됩니다',
      });
    }

    // ─── PATCH: 박물관 PC가 상태 보고 ───
    if (req.method === 'PATCH') {
      const { state, battery_level, fan_speed, today_clean_area, 
              today_clean_min, total_clean_count, total_clean_area, 
              consumables, error_code } = req.body || {};

      const updates = {
        current_state: {
          ...(device.current_state || {}),
          ...(state && { state }),
          ...(battery_level != null && { battery_level }),
          ...(fan_speed && { fan_speed }),
          ...(error_code != null && { error_code }),
        },
        updated_at: new Date().toISOString(),
      };
      if (today_clean_area != null) updates.today_clean_area = today_clean_area;
      if (today_clean_min != null) updates.today_clean_min = today_clean_min;
      if (total_clean_count != null) updates.total_clean_count = total_clean_count;
      if (total_clean_area != null) updates.total_clean_area = total_clean_area;
      if (consumables) updates.consumables = consumables;

      await supabaseSvc.from('tapo_devices').update(updates).eq('id', id);

      // 임계값 알림 (배터리 부족, 소모품 교체 시)
      if (battery_level != null && battery_level < 10) {
        await supabaseSvc.from('tapo_device_events').insert({
          device_id: id, zone: device.zone_id,
          event_type: 'low_battery', severity: 'warning',
          title: '🔋 배터리 부족',
          description: `${device.name} 배터리 ${battery_level}%`,
          raw_payload: { battery_level },
          created_at: new Date().toISOString(),
        });
      }

      // 소모품 교체 알림
      if (consumables) {
        const limits = { main_brush: 300, side_brush: 200, filter: 150, sensor: 30 };
        for (const [part, used] of Object.entries(consumables)) {
          if (limits[part] && used >= limits[part] * 0.95) {
            await supabaseSvc.from('tapo_device_events').insert({
              device_id: id, zone: device.zone_id,
              event_type: 'consumable_replace', severity: 'warning',
              title: `🔧 ${getPartName(part)} 교체 필요`,
              description: `사용 시간 ${used}시간 (한계 ${limits[part]}h)`,
              raw_payload: { consumable: part, hours_used: used },
              created_at: new Date().toISOString(),
            });
          }
        }
      }

      return res.status(200).json({ ok: true, updated: true });
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[roborock]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}

function getActionTitle(action) {
  const titles = {
    start: '청소 시작', pause: '일시정지', stop: '청소 중지',
    return_home: '충전소 복귀', find_robot: '로봇 찾기',
    set_fan_speed: '흡입력 변경', clean_zone: '구역 청소',
    clean_segment: '방 청소', set_schedule: '일정 설정',
    reset_consumable: '소모품 리셋',
  };
  return titles[action] || action;
}

function getActionDescription(action, payload) {
  if (action === 'set_fan_speed') return `흡입력: ${payload.speed}`;
  if (action === 'clean_zone') return `${payload.zone} 구역 청소`;
  if (action === 'clean_segment') return `방 ${payload.segment_id} 청소`;
  if (action === 'set_schedule') return `매일 ${payload.schedule_time} 청소`;
  return getActionTitle(action);
}

function getPartName(part) {
  const names = {
    main_brush: '메인 브러시', side_brush: '사이드 브러시',
    filter: '필터', sensor: '센서',
  };
  return names[part] || part;
}
