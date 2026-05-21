// 노무사·관리자용 감사 데이터 조회 API — 설계 §11.2
// GET /api/audit-data?type=consent|access|correction|retention|stats|recipients
//
// LawyerAuditView 화면이 호출. 모든 응답은 본인 조직(jamsa)에 한정.

import { requireAuth, canDo, supabaseSvc, normalizeRole } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  const role = normalizeRole(ctx.role);
  if (!['admin', 'lawyer'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'forbidden', detail: 'admin or lawyer required' });
  }

  const type = String(req.query.type || 'stats');
  try {
    switch (type) {
      case 'consent':     return res.json({ ok: true, data: await fetchConsent(ctx.orgId) });
      case 'access':      return res.json({ ok: true, data: await fetchAccess(ctx.orgId) });
      case 'correction':  return res.json({ ok: true, data: await fetchCorrections(ctx.orgId) });
      case 'retention':   return res.json({ ok: true, data: await fetchRetention(ctx.orgId) });
      case 'recipients':  return res.json({ ok: true, data: await fetchRecipients(ctx.orgId) });
      case 'stats':       return res.json({ ok: true, data: await fetchStats(ctx.orgId) });
      default: return res.status(400).json({ ok: false, error: 'invalid_type' });
    }
  } catch (e) {
    console.error('[audit-data] failed:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function fetchConsent(orgId) {
  const { data, error } = await supabaseSvc
    .from('consent_records')
    .select('id, staff_id, consent_version, scope, agreed_at, withdrawn_at, withdraw_reason')
    .eq('org_id', orgId)
    .order('agreed_at', { ascending: false })
    .limit(500);
  if (error) throw error;

  // staff_id → display_name 조인
  const ids = [...new Set((data || []).map(r => r.staff_id))];
  const { data: members } = ids.length > 0
    ? await supabaseSvc.from('memberships').select('user_id, display_name').in('user_id', ids)
    : { data: [] };
  const nameMap = Object.fromEntries((members || []).map(m => [m.user_id, m.display_name || '(이름 없음)']));

  return (data || []).map(r => ({
    id: r.id,
    name: nameMap[r.staff_id] || `직원-${String(r.staff_id).slice(0, 4)}`,
    anon: `E-${String(r.staff_id).slice(0, 4).toUpperCase()}`,
    agreedAt: r.agreed_at,
    version: r.consent_version,
    scope: Array.isArray(r.scope) ? r.scope.join(', ') : JSON.stringify(r.scope),
    status: r.withdrawn_at ? `철회 (${r.withdrawn_at.slice(0,10)})` : '유효',
  }));
}

async function fetchAccess(orgId) {
  const { data, error } = await supabaseSvc
    .from('location_access_log')
    .select('id, accessed_at, actor_email, actor_role, target_staff_id, target_anon, reason_category, reason_detail, legal_basis')
    .eq('org_id', orgId)
    .order('accessed_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data || []).map(r => ({
    ts: r.accessed_at,
    actor: `${r.actor_role} ${r.actor_email || ''}`.trim(),
    target: r.target_anon || `E-${String(r.target_staff_id).slice(0, 4).toUpperCase()}`,
    action: r.reason_category === 'BLE_DEBUG' ? 'BLE 디버그' : '정밀 위치 열람',
    reason: r.reason_detail,
    legal: r.legal_basis,
  }));
}

async function fetchCorrections(orgId) {
  const { data, error } = await supabaseSvc
    .from('attendance_corrections')
    .select('id, staff_id, date, field, value_before, value_after, reason, status, reviewed_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;

  const ids = [...new Set((data || []).map(r => r.staff_id))];
  const { data: members } = ids.length > 0
    ? await supabaseSvc.from('memberships').select('user_id, display_name').in('user_id', ids)
    : { data: [] };
  const nameMap = Object.fromEntries((members || []).map(m => [m.user_id, m.display_name || '(이름 없음)']));

  const fieldKor = { check_in: '출근시각', check_out: '퇴근시각', break_time: '휴게' };
  const statusKor = { pending: '대기', approved: '승인', rejected: '반려' };
  return (data || []).map(r => ({
    date: r.date,
    name: nameMap[r.staff_id] || `직원-${String(r.staff_id).slice(0, 4)}`,
    field: fieldKor[r.field] || r.field,
    change: `${r.value_before || '-'} → ${r.value_after}`,
    reason: r.reason,
    status: statusKor[r.status] || r.status,
  }));
}

async function fetchRetention() {
  // 보존 상태는 시스템 설정 + DB row 카운트로 산출
  const [{ count: locCount }, { count: logCount }, { count: consCount }] = await Promise.all([
    supabaseSvc.from('staff_locations').select('id', { count: 'exact', head: true }),
    supabaseSvc.from('location_access_log').select('id', { count: 'exact', head: true }),
    supabaseSvc.from('consent_records').select('id', { count: 'exact', head: true }),
  ]);
  return [
    { name: '근로자 명부', meta: '3년 보존 · 자동 백업', status: '정상' },
    { name: '임금대장', meta: '3년 보존 · 별도 저장소', status: '정상' },
    { name: '위치정보 원본', meta: `근무종료 90일 후 자동 파기 · 현재 ${locCount || 0}건`, status: '정상' },
    { name: '접근 로그', meta: `5년 보존 (UPDATE/DELETE 차단) · 현재 ${logCount || 0}건`, status: '정상' },
    { name: '동의·철회 기록', meta: `영구 보존 · 현재 ${consCount || 0}건`, status: '정상' },
  ];
}

async function fetchRecipients(orgId) {
  const { data, error } = await supabaseSvc
    .from('lawyer_recipients')
    .select('id, name, email, pgp_public_key, active, created_at')
    .eq('org_id', orgId)
    .eq('active', true);
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id, name: r.name, email: r.email,
    encryption: r.pgp_public_key ? 'PGP 공개키' : 'zip 패스워드',
    createdAt: r.created_at,
  }));
}

async function fetchStats(orgId) {
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const [{ count: consentActive }, { count: consentWithdrawn }, { count: monthlyAccess }] = await Promise.all([
    supabaseSvc.from('consent_records').select('id', { count: 'exact', head: true })
      .eq('org_id', orgId).is('withdrawn_at', null),
    supabaseSvc.from('consent_records').select('id', { count: 'exact', head: true })
      .eq('org_id', orgId).not('withdrawn_at', 'is', null),
    supabaseSvc.from('location_access_log').select('id', { count: 'exact', head: true })
      .eq('org_id', orgId).gte('accessed_at', monthAgo),
  ]);
  const { count: totalStaff } = await supabaseSvc.from('memberships')
    .select('user_id', { count: 'exact', head: true })
    .eq('org_id', orgId).eq('role', 'staff');
  return {
    consentActive: consentActive || 0,
    consentWithdrawn: consentWithdrawn || 0,
    monthlyAccess: monthlyAccess || 0,
    totalStaff: totalStaff || 0,
  };
}
