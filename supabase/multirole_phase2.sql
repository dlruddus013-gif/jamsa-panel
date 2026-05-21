-- ════════════════════════════════════════════════════════════
-- Phase 2 — 정밀 위치 접근 통제
-- ════════════════════════════════════════════════════════════
-- 설계 문서 §3.3, §4.1, §4.2 참고.
-- 실행 전: Phase 1 (multirole_phase1.sql) 적용 필수.
-- ════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════
-- 1. 정밀 위치 접근 로그 (영구 보존)
-- ═══════════════════════════════════════════
create table if not exists public.location_access_log (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  accessed_at timestamptz not null default now(),
  actor_user_id uuid not null references auth.users(id),
  actor_role text not null,
  actor_email text,
  target_staff_id text not null,            -- staff_locations.id (text)
  target_anon text,                          -- E-XXXX 익명 ID (있으면)
  reason_category text not null,             -- BLE_DEBUG / EMERGENCY / PAYROLL_VERIFY / CUSTOMER_ISSUE / OTHER
  reason_detail text not null check (char_length(reason_detail) >= 50),
  legal_basis text not null,
  data_returned jsonb,                       -- 무엇이 반환되었는지 (lat/lng/source 등)
  ip inet,
  user_agent text
);

create index if not exists lal_target_idx on public.location_access_log (target_staff_id, accessed_at desc);
create index if not exists lal_actor_idx  on public.location_access_log (actor_user_id, accessed_at desc);
create index if not exists lal_org_time_idx on public.location_access_log (org_id, accessed_at desc);

-- ═══════════════════════════════════════════
-- 2. RLS — 영구 보존 (UPDATE/DELETE 차단)
-- ═══════════════════════════════════════════
alter table public.location_access_log enable row level security;

-- 관리자·노무사는 본인 조직 로그 조회 가능
drop policy if exists lal_admin_lawyer_read on public.location_access_log;
create policy lal_admin_lawyer_read on public.location_access_log
  for select to authenticated using (
    exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = location_access_log.org_id
        and m.role in ('admin','lawyer')
        and (m.expires_at is null or m.expires_at > now())
    )
  );

-- 직원 본인은 자기 자신이 대상이 된 로그 조회 가능 (위치정보법 제24조 — 사후 열람권)
drop policy if exists lal_target_self_read on public.location_access_log;
create policy lal_target_self_read on public.location_access_log
  for select to authenticated using (
    target_staff_id = auth.uid()::text
  );

-- INSERT는 service-role 만 (앱 서버 측 /api/precise-location 핸들러)
-- authenticated 사용자는 직접 INSERT 불가
revoke insert on public.location_access_log from authenticated, anon;

-- UPDATE/DELETE 영구 차단 (위치정보법 시행령 — 접근 기록 변경 금지)
revoke update, delete on public.location_access_log from authenticated, anon, public;

-- ═══════════════════════════════════════════
-- 3. staff_locations RLS 강화 (참고: Phase 5에서 anon 정책 제거 예정)
-- ═══════════════════════════════════════════
-- 현재 staff_locations 는 익명 read/write 가능 (BLE 비콘 수집 위해).
-- 본격적인 정밀 좌표 마스킹은 클라이언트 권한 분리(Phase 5) 시점에 진행.
-- 여기서는 staff 본인이 본인 위치 조회하는 정책만 보강.

alter table public.staff_locations enable row level security;

drop policy if exists loc_owner_select on public.staff_locations;
create policy loc_owner_select on public.staff_locations
  for select to authenticated using (
    -- 본인 위치는 항상 조회 가능
    id = auth.uid()::text
    or
    -- 같은 조직의 admin/lawyer 는 조회 가능 (단, 서버 핸들러에서 로그 INSERT 후 호출)
    exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid()
        and m.role in ('admin','lawyer')
        and (m.expires_at is null or m.expires_at > now())
    )
  );

-- 기존 익명 read 정책은 staff_locations_table.sql 에서 만들어진 그대로 유지
-- (loc_anon_read) — Phase 5에서 제거하고 토큰 기반으로 교체 예정.

commit;

-- ════════════════════════════════════════════════════════════
-- 검증 SQL
-- ════════════════════════════════════════════════════════════
-- 정상 INSERT (service-role):
--   insert into public.location_access_log
--     (org_id, actor_user_id, actor_role, target_staff_id, reason_category, reason_detail, legal_basis)
--   values
--     ('jamsa', auth.uid(), 'admin', 'staff-test-id', 'BLE_DEBUG',
--      '14:32 BLE 게이트웨이 신호가 끊긴 시점부터 현장 위치 확인 필요',
--      '위치정보법 제16조');
--
-- 50자 미만 사유 → CHECK 실패:
--   ... values (..., 'BLE_DEBUG', '짧은 사유', '...');
--
-- UPDATE/DELETE 시도 → 권한 거부:
--   update public.location_access_log set reason_detail = '...' where id = '...';

-- ════════════════════════════════════════════════════════════
-- 롤백
-- ════════════════════════════════════════════════════════════
-- begin;
-- drop policy if exists lal_admin_lawyer_read on public.location_access_log;
-- drop policy if exists lal_target_self_read on public.location_access_log;
-- drop policy if exists loc_owner_select on public.staff_locations;
-- drop table if exists public.location_access_log;
-- commit;
