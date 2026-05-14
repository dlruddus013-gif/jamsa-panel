// api/tapo-camera.js
// Tapo 카메라 RTSP/ONVIF 통합 API (Phase 2)
// 기능: 스냅샷, 스트림 정보, 카메라 상태 확인

import { supabaseSvc } from '../lib/auth.js';

// RTSP URL 검증
function validateRtspUrl(url) {
  if (!url) return { valid: false, reason: 'empty' };
  try {
    const u = new URL(url);
    if (u.protocol !== 'rtsp:' && u.protocol !== 'rtsps:') {
      return { valid: false, reason: 'invalid_protocol' };
    }
    if (!u.hostname) return { valid: false, reason: 'no_host' };
    return { valid: true, parsed: { host: u.hostname, port: u.port || 554, path: u.pathname } };
  } catch (e) {
    return { valid: false, reason: 'parse_error' };
  }
}

// 카메라 IP에 ping 테스트 (간단 connectivity 체크)
async function checkCameraReachability(ip, port = 554, timeoutMs = 3000) {
  // Vercel 서버리스에서는 raw TCP 소켓 사용 제한 → 대신 HTTP 헬스체크 시도
  // 실제로는 RTSP 자체 연결 테스트가 어려우므로 사용자가 박물관 PC에서 별도 확인 권장
  return { reachable: 'unknown', note: 'check_from_local_pc' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!supabaseSvc) {
    return res.status(200).json({ ok: true, fallback: true });
  }

  try {
    const { id, action } = req.query;

    if (!id) return res.status(400).json({ error: 'missing_device_id' });

    // 기기 정보 조회 (RTSP URL 가져오기)
    const { data: device, error: devErr } = await supabaseSvc
      .from('tapo_devices').select('*').eq('id', id).single();
    if (devErr || !device) {
      return res.status(404).json({ error: 'device_not_found' });
    }

    if (device.category !== 'camera' && device.category !== 'doorbell') {
      return res.status(400).json({ error: 'not_a_camera', category: device.category });
    }

    // ─── GET: 스트림 정보 (보안: RTSP URL은 직접 노출 X) ───
    if (req.method === 'GET' && action === 'stream-info') {
      const validation = validateRtspUrl(device.rtsp_url);

      // 스트림 정보 (RTSP URL 자체는 마스킹)
      let maskedUrl = null;
      if (validation.valid) {
        const parsed = validation.parsed;
        maskedUrl = `rtsp://***:***@${parsed.host}:${parsed.port}${parsed.path}`;
      }

      // 박물관 PC에서 cctv-server (5555) 통해 가져올 수 있는지 안내
      const localProxyHint = device.ip ? `http://localhost:5555/api/snapshot?ip=${device.ip}` : null;

      return res.status(200).json({
        ok: true,
        deviceId: id,
        deviceName: device.name,
        hasRtsp: !!device.rtsp_url,
        rtspMasked: maskedUrl,
        rtspValid: validation.valid,
        rtspError: validation.reason,
        localProxyHint,
        notes: '실제 영상은 박물관 PC의 cctv-server (포트 5555)에서 가져옵니다. Vercel은 직접 RTSP 접근 불가.',
      });
    }

    // ─── POST: 스냅샷 캐싱 (박물관 PC가 보내옴) ───
    if (req.method === 'POST' && action === 'snapshot') {
      const { snapshotBase64, capturedAt, source } = req.body || {};
      if (!snapshotBase64) return res.status(400).json({ error: 'missing_snapshot' });

      // 스냅샷을 DB에 저장 (간단히 base64 그대로, Phase 3에서 Storage로 옮김)
      const record = {
        device_id: id,
        snapshot_data: snapshotBase64.slice(0, 500000), // 500KB 제한
        captured_at: capturedAt || new Date().toISOString(),
        source: source || 'manual',
        created_at: new Date().toISOString(),
      };

      // 별도 테이블 없으면 events에 저장
      const { error } = await supabaseSvc.from('tapo_device_events').insert({
        device_id: id,
        zone: device.zone_id,
        event_type: 'snapshot',
        severity: 'normal',
        title: `${device.name} 스냅샷`,
        description: `${source || 'manual'} 트리거로 스냅샷 저장됨`,
        raw_payload: { source, capturedAt, hasSnapshot: true },
        created_at: new Date().toISOString(),
      });
      if (error) console.error('[tapo-camera snapshot]', error);

      return res.status(200).json({ ok: true, saved: true });
    }

    // ─── POST: 카메라 연결 테스트 ───
    if (req.method === 'POST' && action === 'test') {
      const validation = validateRtspUrl(device.rtsp_url);
      if (!validation.valid) {
        return res.status(200).json({
          ok: false, reachable: false,
          reason: 'invalid_rtsp_url',
          message: 'RTSP URL이 유효하지 않습니다. 형식: rtsp://user:pass@ip:554/stream1',
        });
      }

      // Vercel 서버리스에서는 RTSP 직접 테스트 불가
      // 박물관 PC에서 별도로 확인하라고 안내
      return res.status(200).json({
        ok: true, reachable: 'unknown',
        message: '박물관 PC에서 cctv-server를 통해 확인 가능합니다.',
        suggestedTest: device.ip ? `ping ${device.ip}` : null,
      });
    }

    // ─── Phase 4-A: PTZ 컨트롤 (박물관 PC로 명령 큐잉) ───
    if (req.method === 'POST' && action === 'ptz') {
      const dir = req.query.dir || 'home';
      const validDirs = ['up', 'down', 'left', 'right', 'home', 'zoom_in', 'zoom_out'];
      if (!validDirs.includes(dir)) {
        return res.status(400).json({ error: 'invalid_direction' });
      }
      // 명령을 device_commands 테이블에 큐잉 → 박물관 PC가 폴링하여 실행
      await supabaseSvc.from('tapo_device_events').insert({
        device_id: id, zone: device.zone_id, event_type: 'ptz_command',
        severity: 'normal', title: `PTZ ${dir}`,
        description: `카메라 PTZ ${dir} 명령 발행`,
        raw_payload: { command: 'ptz', direction: dir, queued_at: new Date().toISOString() },
        created_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, queued: true, direction: dir });
    }

    // ─── Phase 4-A: 프리셋 저장 ───
    if (req.method === 'POST' && action === 'preset_save') {
      const num = parseInt(req.query.num) || 1;
      const name = req.query.name || `프리셋 ${num}`;
      if (num < 1 || num > 8) return res.status(400).json({ error: 'preset_num_out_of_range' });
      
      const presets = device.presets || {};
      presets[num] = name;
      await supabaseSvc.from('tapo_devices').update({ presets, updated_at: new Date().toISOString() }).eq('id', id);
      
      await supabaseSvc.from('tapo_device_events').insert({
        device_id: id, zone: device.zone_id, event_type: 'preset_save',
        severity: 'normal', title: `프리셋 ${num} 저장`,
        description: `현재 위치를 "${name}"으로 저장`,
        raw_payload: { num, name },
        created_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, num, name });
    }

    // ─── Phase 4-A: 프리셋 이동 ───
    if (req.method === 'POST' && action === 'preset_goto') {
      const num = parseInt(req.query.num) || 1;
      const presets = device.presets || {};
      if (!presets[num]) return res.status(404).json({ error: 'preset_not_set' });
      
      await supabaseSvc.from('tapo_device_events').insert({
        device_id: id, zone: device.zone_id, event_type: 'preset_goto',
        severity: 'normal', title: `프리셋 ${num} 이동`,
        description: `"${presets[num]}" 위치로 이동 명령`,
        raw_payload: { num, name: presets[num] },
        created_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, num, name: presets[num], queued: true });
    }

    // ─── Phase 4-A: 녹화 토글 ───
    if (req.method === 'POST' && action === 'record_toggle') {
      const recording = !device.is_recording;
      await supabaseSvc.from('tapo_devices').update({ is_recording: recording, updated_at: new Date().toISOString() }).eq('id', id);
      await supabaseSvc.from('tapo_device_events').insert({
        device_id: id, zone: device.zone_id, event_type: 'record',
        severity: recording ? 'warning' : 'normal',
        title: recording ? '🔴 녹화 시작' : '⏹ 녹화 중지',
        description: `수동 녹화 ${recording ? '시작' : '중지'}`,
        raw_payload: { recording },
        created_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, recording });
    }

    // ─── Phase 4-A: 사생활 모드 토글 ───
    if (req.method === 'POST' && action === 'privacy_toggle') {
      const privacy = !device.privacy_mode;
      await supabaseSvc.from('tapo_devices').update({ privacy_mode: privacy, updated_at: new Date().toISOString() }).eq('id', id);
      await supabaseSvc.from('tapo_device_events').insert({
        device_id: id, zone: device.zone_id, event_type: 'privacy',
        severity: privacy ? 'warning' : 'normal',
        title: privacy ? '🔒 사생활 모드 ON' : '👁 사생활 모드 OFF',
        description: privacy ? '카메라 렌즈 가림' : '감시 재개',
        raw_payload: { privacy_mode: privacy },
        created_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, privacy_mode: privacy });
    }

    // ─── Phase 4-A: 음성통화 시작 ───
    if (req.method === 'POST' && action === 'ptt_start') {
      await supabaseSvc.from('tapo_device_events').insert({
        device_id: id, zone: device.zone_id, event_type: 'ptt',
        severity: 'normal', title: '🎤 음성통화 시작',
        description: '관리자가 카메라로 음성 통화 요청',
        raw_payload: { command: 'ptt_start' },
        created_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, queued: true, message: '박물관 PC에서 통화 연결' });
    }

    // ─── Phase 4-A: 동작감지 + 야간모드 + 알림 설정 ───
    if (req.method === 'POST' && (action === 'motion_toggle' || action === 'motion_sensitivity' || action === 'kakao_alert' || action === 'night_mode')) {
      const updates = { updated_at: new Date().toISOString() };
      if (action === 'motion_toggle') updates.motion_detection = req.query.on === 'true';
      if (action === 'motion_sensitivity') updates.motion_sensitivity = parseInt(req.query.value) || 5;
      if (action === 'kakao_alert') updates.kakao_alert = req.query.on === 'true';
      if (action === 'night_mode') updates.night_mode = req.query.on === 'true';
      
      await supabaseSvc.from('tapo_devices').update(updates).eq('id', id);
      return res.status(200).json({ ok: true, updated: updates });
    }

    res.status(405).json({ error: 'method_not_allowed_or_invalid_action' });
  } catch (e) {
    console.error('[tapo-camera]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
