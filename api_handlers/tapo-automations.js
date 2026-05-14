// api/tapo-automations.js
// Tapo 자동화 엔진 - 16개 템플릿 + 사용자 정의 자동화

import { supabaseSvc } from '../lib/auth.js';

// 16개 자동화 템플릿
const AUTOMATION_TEMPLATES = [
  {
    id: 'opening_mode', name: '🌅 운영 시작 모드',
    description: '매일 9시에 조명/카메라/플러그 자동 ON',
    triggers: [{ type: 'time', value: '09:00' }],
    conditions: [{ type: 'weekday', value: ['mon','tue','wed','thu','fri','sat','sun'] }],
    actions: [
      { type: 'turn_on', target: 'category:light', zones: ['*'] },
      { type: 'turn_on', target: 'category:camera', zones: ['*'] },
      { type: 'mode', value: 'operating' },
    ],
    severity: 'normal', enabled: false,
  },
  {
    id: 'closing_mode', name: '🌙 운영 종료 모드',
    description: '매일 18시: 조명 OFF, 야간 모드 카메라 ON',
    triggers: [{ type: 'time', value: '18:00' }],
    conditions: [],
    actions: [
      { type: 'turn_off', target: 'category:light', zones: ['*'] },
      { type: 'set_mode', target: 'category:camera', value: 'night' },
      { type: 'mode', value: 'after_hours' },
    ],
    severity: 'normal', enabled: false,
  },
  {
    id: 'night_intrusion', name: '🚨 야간 침입 감지',
    description: '22-08시 모션 감지 → 즉시 SMS + 영상 저장',
    triggers: [{ type: 'sensor_event', target: 'category:motion_sensor', condition: 'detected' }],
    conditions: [{ type: 'time_range', value: '22:00-08:00' }],
    actions: [
      { type: 'snapshot_nearby', radius: 50 },
      { type: 'send_sms', target: 'staff_all' },
      { type: 'create_event', severity: 'danger' },
    ],
    severity: 'danger', enabled: false,
  },
  {
    id: 'kids_safety', name: '🎈 키즈카페 안전 감지',
    description: '에어바운스 모션 + 카메라 AI 통합',
    triggers: [{ type: 'sensor_event', target: 'zone:kids_cafe', condition: 'detected' }],
    conditions: [{ type: 'cctv_ai', value: 'crowded' }],
    actions: [
      { type: 'send_alert', message: '키즈카페 밀집 + 모션 동시 감지' },
      { type: 'create_event', severity: 'caution' },
    ],
    severity: 'caution', enabled: false,
  },
  {
    id: 'sheep_fence', name: '🐑 양떼정원 울타리 접근',
    description: '야간 양떼정원 모션 → 알림',
    triggers: [{ type: 'sensor_event', target: 'zone:sheep_garden', condition: 'detected' }],
    conditions: [{ type: 'time_range', value: '20:00-06:00' }],
    actions: [
      { type: 'snapshot_nearby', zone: 'sheep_garden' },
      { type: 'send_alert', message: '양떼정원 야간 접근 감지' },
    ],
    severity: 'caution', enabled: false,
  },
  {
    id: 'air_bounce_power', name: '⚡ 에어바운스 전원 이상',
    description: '에어바운스 전력 측정 → 이상 감지',
    triggers: [{ type: 'energy_threshold', target: 'zone:air_bounce', condition: 'below_or_above' }],
    conditions: [],
    actions: [
      { type: 'send_alert', message: '에어바운스 전력 이상 - 점검 필요' },
      { type: 'create_event', severity: 'danger' },
    ],
    severity: 'danger', enabled: false,
  },
  {
    id: 'water_leak', name: '💦 누수 감지',
    description: '누수 센서 → 즉시 호출',
    triggers: [{ type: 'sensor_event', target: 'category:water_leak_sensor', condition: 'detected' }],
    conditions: [],
    actions: [
      { type: 'send_sms', target: 'staff_facility', urgency: 'urgent' },
      { type: 'create_event', severity: 'danger' },
      { type: 'auto_incident', module: 'safety' },
    ],
    severity: 'danger', enabled: false,
  },
  {
    id: 'over_power', name: '⚡ 과전력 감지',
    description: '기준 전력 초과 → 자동 차단',
    triggers: [{ type: 'energy_threshold', value: 3000, condition: 'above' }],
    conditions: [],
    actions: [
      { type: 'turn_off', target: 'self' },
      { type: 'send_alert', message: '과전력 감지 - 자동 차단됨' },
      { type: 'create_event', severity: 'danger' },
    ],
    severity: 'danger', enabled: false,
  },
  {
    id: 'temp_humidity', name: '🌡️ 온습도 냉난방 제어',
    description: '기준 벗어나면 IR 리모컨으로 자동 제어',
    triggers: [
      { type: 'temperature_threshold', condition: 'above', value: 28 },
      { type: 'temperature_threshold', condition: 'below', value: 18 },
    ],
    conditions: [{ type: 'mode', value: 'operating' }],
    actions: [
      { type: 'ir_command', target: 'category:ir_remote', command: 'cool_or_heat' },
      { type: 'create_event', severity: 'normal' },
    ],
    severity: 'normal', enabled: false,
  },
  {
    id: 'cctv_offline', name: '📹 CCTV 오프라인 알림',
    description: 'CCTV 영상 끊기면 즉시 알림',
    triggers: [{ type: 'device_offline', target: 'category:camera', duration: 300 }], // 5분
    conditions: [],
    actions: [
      { type: 'send_alert', message: 'CCTV 오프라인 - 점검 필요' },
      { type: 'create_event', severity: 'caution' },
    ],
    severity: 'caution', enabled: false,
  },
  {
    id: 'low_battery', name: '🔋 배터리 부족 알림',
    description: '센서 배터리 20% 이하 알림',
    triggers: [{ type: 'battery_threshold', value: 20, condition: 'below' }],
    conditions: [],
    actions: [
      { type: 'send_alert', message: '센서 배터리 교체 필요' },
      { type: 'create_event', severity: 'normal' },
    ],
    severity: 'normal', enabled: false,
  },
  {
    id: 'panic_button', name: '🔘 직원 비상버튼 호출',
    description: '비상버튼 누름 → 모든 직원 호출',
    triggers: [{ type: 'sensor_event', target: 'category:button', condition: 'pressed' }],
    conditions: [],
    actions: [
      { type: 'send_sms', target: 'staff_all', urgency: 'urgent' },
      { type: 'snapshot_nearby', radius: 30 },
      { type: 'create_event', severity: 'danger' },
      { type: 'auto_incident', module: 'safety' },
    ],
    severity: 'danger', enabled: false,
  },
  {
    id: 'complaint_snapshot', name: '📸 민원 발생 시 스냅샷',
    description: '근처 카메라 영상 자동 저장',
    triggers: [{ type: 'manual_trigger', source: 'safety_module' }],
    conditions: [],
    actions: [
      { type: 'snapshot_nearby', radius: 100 },
      { type: 'save_sensor_logs', duration: 600 },
    ],
    severity: 'normal', enabled: false,
  },
  {
    id: 'rainy_indoor', name: '🌧️ 비 오는 날 모드',
    description: '실내 구역 집중 운영 자동화',
    triggers: [{ type: 'weather', condition: 'rainy' }],
    conditions: [{ type: 'mode', value: 'operating' }],
    actions: [
      { type: 'turn_on', target: 'zone:indoor_areas' },
      { type: 'send_alert', message: '우천 모드 활성 - 실내 구역 점검 권장' },
    ],
    severity: 'normal', enabled: false,
  },
  {
    id: 'night_lights', name: '✨ 야간 빛축제 조명',
    description: '행사 시 조명 자동 시퀀스',
    triggers: [{ type: 'manual_trigger' }],
    conditions: [],
    actions: [
      { type: 'sequence_lights', target: 'category:light', pattern: 'festival' },
      { type: 'duration', value: 7200 }, // 2시간
    ],
    severity: 'normal', enabled: false,
  },
  {
    id: 'group_visit', name: '🎓 단체 방문 모드',
    description: '예약 시 CCTV 민감도 조정',
    triggers: [{ type: 'reservation_event', condition: 'group_arriving' }],
    conditions: [],
    actions: [
      { type: 'cctv_sensitivity', value: 'high' },
      { type: 'send_alert', message: '단체 방문 시작 - CCTV 민감도 상향' },
    ],
    severity: 'normal', enabled: false,
  },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabaseSvc) {
    return res.status(200).json({ ok: true, fallback: true, templates: AUTOMATION_TEMPLATES });
  }

  try {
    // ─── GET: 자동화 목록 + 템플릿 ───
    if (req.method === 'GET') {
      if (req.query.templates === 'true') {
        return res.status(200).json({ ok: true, templates: AUTOMATION_TEMPLATES });
      }

      // 사용자 자동화 조회
      const { data: automations, error } = await supabaseSvc
        .from('tapo_automations').select('*').order('created_at', { ascending: false });
      if (error) throw error;

      // 최근 실행 로그
      const { data: logs } = await supabaseSvc
        .from('tapo_automation_logs')
        .select('*')
        .order('executed_at', { ascending: false }).limit(20);

      // 통계
      const stats = {
        total: (automations || []).length,
        enabled: (automations || []).filter(a => a.enabled).length,
        recentRuns: (logs || []).length,
        successRate: logs && logs.length > 0
          ? Math.round(logs.filter(l => l.success).length / logs.length * 100)
          : 0,
      };

      return res.status(200).json({
        ok: true, automations: automations || [], logs: logs || [], stats,
        templates: AUTOMATION_TEMPLATES,
      });
    }

    // ─── POST: 자동화 생성 ───
    if (req.method === 'POST') {
      const { templateId, name, description, triggers, conditions, actions, severity = 'normal', enabled = false } = req.body || {};

      let record;
      if (templateId) {
        const template = AUTOMATION_TEMPLATES.find(t => t.id === templateId);
        if (!template) return res.status(400).json({ error: 'invalid_template' });
        record = {
          template_id: template.id,
          name: name || template.name,
          description: description || template.description,
          triggers: triggers || template.triggers,
          conditions: conditions || template.conditions,
          actions: actions || template.actions,
          severity: severity || template.severity,
          enabled: enabled,
          created_at: new Date().toISOString(),
        };
      } else {
        // 사용자 정의
        if (!name || !triggers || !actions) {
          return res.status(400).json({ error: 'missing_required' });
        }
        record = {
          template_id: null,
          name, description: description || '',
          triggers, conditions: conditions || [], actions,
          severity, enabled,
          created_at: new Date().toISOString(),
        };
      }

      const { data, error } = await supabaseSvc
        .from('tapo_automations').insert(record).select().single();
      if (error) throw error;
      return res.status(200).json({ ok: true, automation: data });
    }

    // ─── PATCH: 자동화 수정 ───
    if (req.method === 'PATCH') {
      const { id, ...updates } = req.body || {};
      if (!id) return res.status(400).json({ error: 'missing_id' });
      const { data, error } = await supabaseSvc
        .from('tapo_automations')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id).select().single();
      if (error) throw error;
      return res.status(200).json({ ok: true, automation: data });
    }

    // ─── DELETE: 자동화 삭제 ───
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'missing_id' });
      const { error } = await supabaseSvc.from('tapo_automations').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true, deleted: true });
    }

    // ─── POST 변형: 수동 실행 (action=run) ───
    if (req.method === 'POST' && req.query.action === 'run') {
      const id = req.query.id;
      const { data: automation, error } = await supabaseSvc
        .from('tapo_automations').select('*').eq('id', id).single();
      if (error || !automation) return res.status(404).json({ error: 'not_found' });

      // 실행 로그 (실제 액션은 박물관 PC가 받아서 처리 - Phase 3 영역)
      const log = {
        automation_id: automation.id,
        triggered_by: 'manual',
        actions_executed: automation.actions,
        success: true,
        notes: 'UI 트리거 - 실제 실행은 박물관 PC가 처리',
        executed_at: new Date().toISOString(),
      };
      const { data: logRecord } = await supabaseSvc
        .from('tapo_automation_logs').insert(log).select().single();

      return res.status(200).json({
        ok: true, log: logRecord, automation,
        notes: '실행 트리거 기록됨. 실제 액션은 박물관 PC 자동화 스크립트가 받아서 처리합니다.',
      });
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[tapo-automations]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
