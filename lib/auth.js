// lib/auth.js - JWT 검증 + 권한 체크 + Rate limit
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORG_ID = process.env.ORG_ID || 'jamsa';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[auth] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

// service-role client (RLS 우회 가능, 서버에서만 사용)
export const adminClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Backward-compatible alias used by operation/device API routes.
export const supabaseSvc = adminClient;

// ── 간단한 in-memory rate limit (인스턴스당) ──
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120; // 분당 120회

export function checkRateLimit(key) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_WINDOW_MS;
  }
  bucket.count++;
  rateBuckets.set(key, bucket);
  return bucket.count <= RATE_MAX;
}

// ── CORS 헤더 ──
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ── 익명 읽기용 컨텍스트 (CORS + rate limit만 적용, 인증 불필요) ──
// 잠사박물관 패널은 단일 org 전용이라 ORG_ID 가 고정값('jamsa')입니다.
// 읽기는 누구에게나 공개 — 다른 IP/기기에서도 같은 지도/CCTV 배치를 볼 수 있도록.
// 쓰기는 여전히 requireAuth 필요.
export function publicReadContext(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return null; }
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  if (!checkRateLimit('public:' + ip)) {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfter: 60 });
    return null;
  }
  return { orgId: ORG_ID, ip };
}

// ── 인증된 사용자 정보 추출 ──
// 반환: { user, role, orgId } 또는 응답 후 null
export async function requireAuth(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return null;
  }

  // Rate limit: IP 기반
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfter: 60 });
    return null;
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_token' });
    return null;
  }

  const token = auth.slice(7);
  const { data: { user }, error } = await adminClient.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'invalid_token', detail: error?.message });
    return null;
  }

  // 조직 멤버십 + 역할 — 없으면 자동 생성 (잠사박물관 단일 org 정책)
  // "로그인만 하면 수정 가능" 정책. 새 가입자도 즉시 편집할 수 있도록 자동 enroll.
  let { data: membership } = await adminClient
    .from('memberships')
    .select('role, dept, display_name')
    .eq('user_id', user.id)
    .eq('org_id', ORG_ID)
    .single();

  if (!membership) {
    // 자동 등록 시도
    try {
      const { data: created } = await adminClient
        .from('memberships')
        .upsert(
          {
            user_id: user.id,
            org_id: ORG_ID,
            role: 'staff',
            display_name: user.email?.split('@')[0] || 'member',
          },
          { onConflict: 'user_id,org_id' }
        )
        .select('role, dept, display_name')
        .single();
      if (created) membership = created;
    } catch (e) {
      console.warn('[auth] auto-enroll failed:', e?.message);
    }
    // 자동 등록도 실패하면 가상 멤버로 진행 (DB 스키마 문제여도 쓰기는 허용)
    if (!membership) {
      membership = { role: 'staff', dept: null, display_name: user.email?.split('@')[0] || 'member' };
    }
  }

  return {
    user,
    role: membership.role,
    dept: membership.dept,
    displayName: membership.display_name,
    orgId: ORG_ID,
    ip,
    userAgent: req.headers['user-agent']?.slice(0, 200) || '',
  };
}

// ── 역할 체크 ──
export function hasRole(ctx, ...allowedRoles) {
  return allowedRoles.includes(ctx.role);
}

// ── 6역할 정규화 ──
// 입력: 기존 대문자 ROLE(ADMIN/MANAGER/VISITOR), 구 키(manager/inspector/viewer),
//      신규 6역할(staff/lead/admin/ceo/lawyer/customer), 빈값/대소문자 혼합 등
// 출력: 6역할 중 하나 (기본 'staff')
const LEGACY_ROLE_MAP = {
  ADMIN: 'admin',
  MANAGER: 'lead',
  manager: 'lead',
  STAFF: 'staff',
  INSPECTOR: 'staff',
  inspector: 'staff',
  VIEWER: 'staff',
  viewer: 'staff',
  VISITOR: 'customer',
  visitor: 'customer',
};

export function normalizeRole(raw) {
  if (!raw) return 'staff';
  const r = String(raw).trim();
  if (['staff','lead','admin','ceo','lawyer','customer'].includes(r)) return r;
  return LEGACY_ROLE_MAP[r] || LEGACY_ROLE_MAP[r.toLowerCase()] || LEGACY_ROLE_MAP[r.toUpperCase()] || 'staff';
}

// ── 권한 매트릭스 ──
// 설계 문서 §5.2 PERMISSIONS 참고. 정밀 위치 등 ⚠️ 표시 항목은
// canDo()로 1차 통과 후 별도 사유·로그 처리 필요 (설계 §5.3).
export const PERMISSIONS = {
  view_own_attendance:        ['staff','lead','admin','lawyer'],
  view_team_attendance:       ['lead','admin','lawyer'],
  view_all_attendance:        ['admin','lawyer'],
  view_own_location:          ['staff','admin','lawyer'],
  view_precise_location:      ['admin'],
  view_aggregate_kpi:         ['lead','admin','ceo','lawyer'],
  view_access_log:            ['admin','lawyer'],
  view_consent_records:       ['admin','lawyer'],
  view_anonymous_progress:    ['lead','admin','ceo','lawyer','customer'],
  approve_correction:         ['admin'],
  generate_audit_package:     ['lawyer','admin'],
  manage_permissions:         ['admin'],
};

export function canDo(role, action) {
  const normalized = normalizeRole(role);
  return (PERMISSIONS[action] || []).includes(normalized);
}

// ── 감사로그 기록 ──
export async function audit(ctx, action, resource, payload = {}) {
  try {
    await adminClient.from('audit_logs').insert({
      org_id: ctx.orgId,
      user_id: ctx.user.id,
      user_email: ctx.user.email,
      action,
      resource,
      payload,
      ip_address: ctx.ip,
      user_agent: ctx.userAgent,
    });
  } catch (e) {
    console.warn('[audit] failed:', e.message);
  }
}

// ── 입력 검증 ──
export function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) return false;
  // jamsa_ prefix 강제 (실수로 전체 데이터 덮어쓰기 방지)
  if (!/^jamsa_[a-z0-9_-]+$/i.test(key)) return false;
  return true;
}

export function validateValueSize(value, maxBytes = 5 * 1024 * 1024) {
  try {
    const size = JSON.stringify(value).length;
    return size <= maxBytes;
  } catch (e) {
    return false;
  }
}
