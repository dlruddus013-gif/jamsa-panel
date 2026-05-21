// 동의 기록 API — 설계 §3.2, §4.3, §6
// GET  /api/consent          — 본인 동의 이력 조회 (admin/lawyer은 ?staff_id 지정 가능)
// POST /api/consent          — 신규 동의 등록 (본인만)
// PATCH /api/consent/:id     — 동의 철회 (본인만, withdrawn_at 만 set)

import crypto from 'node:crypto';
import { requireAuth, canDo, audit, supabaseSvc, normalizeRole } from '../lib/auth.js';

const CONSENT_TEXT_V32 = [
  '본인은 한국잠사플레이팜 통합관리 시스템의 위치정보 수집·이용에 동의합니다.',
  '수집 항목: GPS 좌표, BLE 신호, 디바이스 ID.',
  '수집 목적: 출퇴근 자동 인식, 근무지 이탈 방지, 비상 안전.',
  '수집 시간: 근무 시작 1시간 전 ~ 종료 30분 후.',
  '보유 기간: 원본 90일 / 집계 3년.',
  '제3자 제공: 없음 (고객사에는 익명화 후).',
  '동의 거부 시 불이익: 없음 (수동 출근 대체).',
].join('\n');
const CONSENT_TEXT_HASH_V32 = crypto.createHash('sha256').update(CONSENT_TEXT_V32, 'utf8').digest('hex');

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (req.method === 'GET') return list(req, res, ctx);
  if (req.method === 'POST') return create(req, res, ctx);
  if (req.method === 'PATCH') return withdraw(req, res, ctx);
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

async function list(req, res, ctx) {
  const role = normalizeRole(ctx.role);
  const targetStaffId = req.query.staff_id;
  let q = supabaseSvc.from('consent_records')
    .select('id, staff_id, consent_version, consent_text_hash, scope, agreed_at, withdrawn_at, withdraw_reason')
    .eq('org_id', ctx.orgId)
    .order('agreed_at', { ascending: false });

  if (role === 'admin' || role === 'lawyer') {
    if (targetStaffId) q = q.eq('staff_id', targetStaffId);
  } else {
    q = q.eq('staff_id', ctx.user.id);
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, records: data, currentText: { version: 'v3.2', hash: CONSENT_TEXT_HASH_V32 } });
}

async function create(req, res, ctx) {
  const { scope } = req.body || {};
  if (!Array.isArray(scope) || scope.length === 0) {
    return res.status(400).json({ ok: false, error: 'scope_required' });
  }
  // 기존 유효 동의가 있으면 거부 (중복 방지)
  const { data: existing } = await supabaseSvc
    .from('consent_records')
    .select('id')
    .eq('staff_id', ctx.user.id)
    .eq('org_id', ctx.orgId)
    .is('withdrawn_at', null)
    .maybeSingle();
  if (existing) {
    return res.status(409).json({ ok: false, error: 'consent_already_active', existingId: existing.id });
  }

  const { data, error } = await supabaseSvc
    .from('consent_records')
    .insert({
      org_id: ctx.orgId,
      staff_id: ctx.user.id,
      consent_version: 'v3.2',
      consent_text_hash: CONSENT_TEXT_HASH_V32,
      scope,
      agreed_ip: ctx.ip,
      agreed_user_agent: ctx.userAgent,
    })
    .select('id, agreed_at')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  await audit(ctx, 'CONSENT_AGREE', `consent_records:${data.id}`, { version: 'v3.2', scope });
  res.json({ ok: true, id: data.id, agreedAt: data.agreed_at, version: 'v3.2' });
}

async function withdraw(req, res, ctx) {
  const consentId = req.query.id || (req.body || {}).id;
  const reason = (req.body || {}).reason || '본인 의사';
  if (!consentId) return res.status(400).json({ ok: false, error: 'consent_id_required' });

  const { data, error } = await supabaseSvc
    .from('consent_records')
    .update({ withdrawn_at: new Date().toISOString(), withdraw_reason: reason })
    .eq('id', consentId)
    .eq('staff_id', ctx.user.id)        // 본인 것만 철회 가능
    .is('withdrawn_at', null)
    .select('id, withdrawn_at')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'not_found_or_already_withdrawn' });

  await audit(ctx, 'CONSENT_WITHDRAW', `consent_records:${consentId}`, { reason });
  // 철회 시 즉시 GPS 수집 중단은 클라이언트에서 처리 (lib/staff-tracker 등)
  res.json({ ok: true, withdrawnAt: data.withdrawn_at });
}
