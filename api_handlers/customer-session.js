// 고객 세션 조회 API (Tier 1·2) — 설계 §11.1
// GET /api/customer-session?token=XXXX     — 토큰 기반 익명 조회 (인증 불필요)
// POST /api/customer-session/issue         — 이슈 신고 (token 기반)
// 인증 없이 호출 가능. RPC security definer + 토큰 검증.

import { applyCors, supabaseSvc } from '../lib/auth.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query.action || (req.method === 'POST' ? 'issue' : 'get');

  if (req.method === 'GET' && action === 'get') return getSession(req, res);
  if (req.method === 'POST' && action === 'issue') return reportIssue(req, res);
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

async function getSession(req, res) {
  const token = req.query.token;
  if (!token) return res.status(400).json({ ok: false, error: 'token_required' });
  if (token.length < 4 || token.length > 80) {
    return res.status(400).json({ ok: false, error: 'invalid_token_format' });
  }

  // RPC security definer 호출 (anon 권한으로도 OK)
  const { data, error } = await supabaseSvc.rpc('get_session_by_token', { p_token: token });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data || data.length === 0) {
    return res.status(404).json({ ok: false, error: 'session_not_found_or_expired' });
  }

  const s = data[0];
  // 익명 출력만 (customer_view_token, org_id, 직원 ID 등은 절대 노출 X)
  res.json({
    ok: true,
    session: {
      id: s.id,
      customer_org: s.customer_org,
      site: s.site_name,
      scheduled_at: s.scheduled_at,
      scheduled_duration_min: s.scheduled_duration_min,
      status: s.status,
      delay_min: s.delay_min,
      issue_count: s.issue_count,
      actual_arrival_at: s.actual_arrival_at,
      assigned_staff_count: s.assigned_staff_count,
    },
  });
}

async function reportIssue(req, res) {
  const { token, type, detail, contact } = req.body || {};
  if (!token || !type || !detail) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }
  if (String(detail).length < 5) {
    return res.status(400).json({ ok: false, error: 'detail_too_short' });
  }

  // 토큰으로 세션 찾고 issue_count + 1
  const { data: sessions, error: rpcErr } = await supabaseSvc.rpc('get_session_by_token', { p_token: token });
  if (rpcErr) return res.status(500).json({ ok: false, error: rpcErr.message });
  if (!sessions || sessions.length === 0) {
    return res.status(404).json({ ok: false, error: 'session_not_found' });
  }
  const session = sessions[0];

  // issue_count 증가 + 별도 audit_log 기록 (별도 customer_issues 테이블은 Phase 5에서)
  await supabaseSvc
    .from('service_sessions')
    .update({ issue_count: (session.issue_count || 0) + 1 })
    .eq('id', session.id);

  await supabaseSvc.from('audit_logs').insert({
    org_id: 'jamsa',
    action: 'CUSTOMER_ISSUE_REPORT',
    resource: `service_sessions:${session.id}`,
    payload: { type, detail: String(detail).slice(0, 2000), contact: contact || null, customer_org: session.customer_org },
    ip_address: req.headers['x-forwarded-for']?.split(',')[0].trim() || null,
    user_agent: (req.headers['user-agent'] || '').slice(0, 200),
  });

  res.json({ ok: true, received_at: new Date().toISOString(), session_id: session.id });
}
