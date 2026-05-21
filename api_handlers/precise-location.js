// 정밀 위치 열람 API — 설계 §5.3, §4.1
// POST /api/precise-location
//   body: { targetStaffId, targetAnon?, reasonCategory, reasonDetail (>=50자), legalBasis }
// 흐름: 인증 → 권한(admin/lawyer) → 사유 검증 → 로그 INSERT(먼저!) → 좌표 조회 → 반환

import { requireAuth, canDo, audit, supabaseSvc } from '../lib/auth.js';

const VALID_CATEGORIES = ['BLE_DEBUG', 'EMERGENCY', 'PAYROLL_VERIFY', 'CUSTOMER_ISSUE', 'OTHER'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const ctx = await requireAuth(req, res);
  if (!ctx) return; // requireAuth가 응답함

  // 권한: admin 만 정밀 위치 열람 가능 (lawyer는 SELECT는 가능하지만 정책상 직접 좌표 열람은 admin)
  if (!canDo(ctx.role, 'view_precise_location')) {
    return res.status(403).json({ ok: false, error: 'forbidden', detail: 'requires admin role' });
  }

  const { targetStaffId, targetAnon, reasonCategory, reasonDetail, legalBasis } = req.body || {};

  if (!targetStaffId || typeof targetStaffId !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_target_staff_id' });
  }
  if (!VALID_CATEGORIES.includes(reasonCategory)) {
    return res.status(400).json({ ok: false, error: 'invalid_reason_category', expected: VALID_CATEGORIES });
  }
  if (typeof reasonDetail !== 'string' || reasonDetail.trim().length < 50) {
    return res.status(400).json({ ok: false, error: 'reason_too_short', minLength: 50 });
  }
  if (!legalBasis || typeof legalBasis !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_legal_basis' });
  }

  // 1) 로그 INSERT 먼저 — 좌표 조회 실패해도 접근 시도는 기록되어야 함
  const { data: logRow, error: logErr } = await supabaseSvc
    .from('location_access_log')
    .insert({
      org_id: ctx.orgId,
      actor_user_id: ctx.user.id,
      actor_role: ctx.role,
      actor_email: ctx.user.email,
      target_staff_id: targetStaffId,
      target_anon: targetAnon || null,
      reason_category: reasonCategory,
      reason_detail: reasonDetail.trim(),
      legal_basis: legalBasis,
      ip: ctx.ip,
      user_agent: ctx.userAgent,
    })
    .select('id, accessed_at')
    .single();

  if (logErr) {
    console.error('[precise-location] log insert failed:', logErr);
    return res.status(500).json({ ok: false, error: 'log_insert_failed', detail: logErr.message });
  }

  // 2) 좌표 조회
  const { data: loc, error: locErr } = await supabaseSvc
    .from('staff_locations')
    .select('id, name, lat, lng, accuracy, source, role, dept, beacon_name, last_seen, updated_at')
    .eq('id', targetStaffId)
    .maybeSingle();

  if (locErr) {
    console.error('[precise-location] location query failed:', locErr);
    return res.status(500).json({ ok: false, error: 'location_query_failed', detail: locErr.message });
  }
  if (!loc) {
    // 로그는 남기되, 좌표 없음을 알림
    await supabaseSvc.from('location_access_log')
      .update({ data_returned: { found: false } })
      .eq('id', logRow.id);
    return res.status(404).json({ ok: false, error: 'location_not_found', accessLogId: logRow.id });
  }

  // 3) 반환 데이터를 로그에 기록 (사후 무엇이 보였는지 추적)
  const returned = {
    found: true,
    lat: loc.lat, lng: loc.lng,
    accuracy: loc.accuracy, source: loc.source,
    lastSeen: loc.last_seen, updatedAt: loc.updated_at,
  };
  await supabaseSvc.from('location_access_log')
    .update({ data_returned: returned })
    .eq('id', logRow.id);

  // 4) 일반 감사 로그도 기록 (운영자가 활동 기록에서 확인할 수 있게)
  await audit(ctx, 'PRECISE_LOCATION_VIEW', `staff_locations:${targetStaffId}`, {
    reasonCategory, legalBasis, accessLogId: logRow.id,
  });

  return res.status(200).json({
    ok: true,
    accessLogId: logRow.id,
    accessedAt: logRow.accessed_at,
    location: {
      id: loc.id,
      name: loc.name,
      lat: loc.lat,
      lng: loc.lng,
      accuracy: loc.accuracy,
      source: loc.source,
      role: loc.role,
      dept: loc.dept,
      beaconName: loc.beacon_name,
      lastSeen: loc.last_seen,
      updatedAt: loc.updated_at,
    },
  });
}
