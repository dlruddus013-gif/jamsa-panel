// 고객 포털 Tier 2 OTP — 설계 §11.1
// POST /api/customer-otp?action=send   — 6자리 코드 발송
// POST /api/customer-otp?action=verify — 코드 검증 후 상세 데이터 반환
//
// 인증 없이 호출 가능. 토큰 + 등록 이메일로만 발송 가능.
// code_hash(SHA-256)만 저장. 평문 보관 금지.

import crypto from 'node:crypto';
import { applyCors, supabaseSvc } from '../lib/auth.js';

const OTP_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'audit@thejamsa.com';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const action = req.query.action;
  if (action === 'send') return send(req, res);
  if (action === 'verify') return verify(req, res);
  return res.status(400).json({ ok: false, error: 'invalid_action' });
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');
}

async function findSessionByToken(token) {
  const { data, error } = await supabaseSvc.rpc('get_session_by_token', { p_token: token });
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data[0];
}

async function sendEmail(to, code, sessionInfo) {
  const subject = `[한국잠사플레이팜] 인증코드 ${code}`;
  const body = `안녕하세요,

${sessionInfo.customer_org}님이 요청하신 서비스 진행 상태 상세 조회 인증코드입니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔐 인증코드: ${code}
⏰ 유효시간: ${OTP_TTL_MIN}분
📍 대상: ${sessionInfo.site_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

본인이 요청한 코드가 아니라면 이 메일을 무시하셔도 됩니다.

한국잠사플레이팜 통합관리 시스템`;

  if (!RESEND_KEY) {
    console.log(`[customer-otp] (simulated) to=${to} code=${code}`);
    return { provider: 'simulated' };
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text: body }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`resend_${r.status}: ${t.slice(0, 200)}`);
  }
  return { provider: 'resend' };
}

async function send(req, res) {
  const { token, email, purpose } = req.body || {};
  if (!token || !email) return res.status(400).json({ ok: false, error: 'token_and_email_required' });
  if (!['detail_view', 'photo_view'].includes(purpose || 'detail_view')) {
    return res.status(400).json({ ok: false, error: 'invalid_purpose' });
  }

  // 토큰으로 세션 찾기
  let session;
  try { session = await findSessionByToken(token); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });

  // 등록된 contact_email 과 매칭 (대소문자 무시)
  const { data: full, error: fullErr } = await supabaseSvc
    .from('service_sessions')
    .select('id, customer_contact_email, site_name, customer_org')
    .eq('id', session.id)
    .single();
  if (fullErr) return res.status(500).json({ ok: false, error: fullErr.message });
  if (!full.customer_contact_email) {
    return res.status(400).json({ ok: false, error: 'session_has_no_contact_email' });
  }
  if (full.customer_contact_email.toLowerCase() !== String(email).toLowerCase()) {
    return res.status(403).json({ ok: false, error: 'email_mismatch', detail: '등록된 담당자 이메일과 다릅니다' });
  }

  // Rate limit: 같은 세션·이메일에 1분에 1회만
  const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const { count: recent } = await supabaseSvc
    .from('customer_otp_log')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', full.id).eq('email', email).gte('sent_at', oneMinAgo);
  if ((recent || 0) >= 1) {
    return res.status(429).json({ ok: false, error: 'rate_limit', detail: '1분 후 다시 시도해주세요' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000).toISOString();

  const { error: insErr } = await supabaseSvc.from('customer_otp_log').insert({
    session_id: full.id,
    email,
    code_hash: hashCode(code),
    purpose: purpose || 'detail_view',
    expires_at: expiresAt,
    ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || null,
    user_agent: (req.headers['user-agent'] || '').slice(0, 200),
  });
  if (insErr) return res.status(500).json({ ok: false, error: insErr.message });

  try {
    const r = await sendEmail(email, code, { customer_org: full.customer_org, site_name: full.site_name });
    return res.json({ ok: true, sentTo: email, expiresInMin: OTP_TTL_MIN, provider: r.provider });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'email_send_failed', detail: e.message });
  }
}

async function verify(req, res) {
  const { token, email, code, purpose } = req.body || {};
  if (!token || !email || !code) return res.status(400).json({ ok: false, error: 'missing_fields' });

  let session;
  try { session = await findSessionByToken(token); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });

  // 최근 발송된 미사용 OTP 1건
  const { data: otp, error: qErr } = await supabaseSvc
    .from('customer_otp_log')
    .select('id, code_hash, expires_at, consumed_at, attempts, purpose')
    .eq('session_id', session.id)
    .eq('email', email)
    .eq('purpose', purpose || 'detail_view')
    .is('consumed_at', null)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (qErr) return res.status(500).json({ ok: false, error: qErr.message });
  if (!otp) return res.status(404).json({ ok: false, error: 'no_active_otp' });

  if (new Date(otp.expires_at) < new Date()) {
    return res.status(410).json({ ok: false, error: 'otp_expired' });
  }
  if ((otp.attempts || 0) >= MAX_ATTEMPTS) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  }

  // attempts 증가는 항상
  await supabaseSvc.from('customer_otp_log')
    .update({ attempts: (otp.attempts || 0) + 1 })
    .eq('id', otp.id);

  if (otp.code_hash !== hashCode(code)) {
    return res.status(401).json({ ok: false, error: 'invalid_code', remaining: MAX_ATTEMPTS - (otp.attempts || 0) - 1 });
  }

  // 성공 — consumed_at 마킹
  await supabaseSvc.from('customer_otp_log')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', otp.id);

  // 상세 데이터 반환 (Tier 1보다 더 자세히 — 실제 도착·완료 시각 등)
  const { data: full } = await supabaseSvc
    .from('service_sessions')
    .select('id, customer_org, site_name, scheduled_at, scheduled_duration_min, status, delay_min, issue_count, actual_arrival_at, assigned_staff_count, created_at')
    .eq('id', session.id)
    .single();

  // 일별 audit 요약 (해당 세션 관련)
  const { data: events } = await supabaseSvc
    .from('audit_logs')
    .select('action, payload, created_at')
    .eq('resource', `service_sessions:${session.id}`)
    .order('created_at', { ascending: false })
    .limit(50);

  res.json({
    ok: true,
    session: full,
    events: (events || []).map(e => ({
      action: e.action,
      at: e.created_at,
      type: e.payload?.type || null,
      // 직원 ID·이름은 절대 노출 X
    })),
    expiresIn: '세션 만료 후 또는 30분',
  });
}
