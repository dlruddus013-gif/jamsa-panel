-- ════════════════════════════════════════════════════════════
-- Phase 1 — 6역할 권한 분리 (memberships.role 확장)
-- ════════════════════════════════════════════════════════════
-- 실행 전:
--   docs/MULTIROLE_DESIGN.md §3 참고
--   기존 memberships 백업 권장: pg_dump --table=memberships
-- ════════════════════════════════════════════════════════════

begin;

-- 1) 기존 데이터를 새 역할 키로 매핑 (CHECK 제약 교체 전)
--    admin   → admin   (그대로)
--    manager → lead    (팀장)
--    inspector → staff (현장 점검자)
--    viewer  → staff   (열람만 가능했던 사용자)
update public.memberships set role = 'lead'  where role = 'manager';
update public.memberships set role = 'staff' where role in ('inspector','viewer');

-- 2) CHECK 제약 교체
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check
  check (role in ('staff','lead','admin','ceo','lawyer','customer'));

-- 3) 시한부 멤버십 컬럼 (노무사 외부 계정용 — 설계 §11.2 경로 A)
alter table public.memberships
  add column if not exists expires_at timestamptz;

create index if not exists memberships_expires_idx
  on public.memberships (expires_at)
  where expires_at is not null;

-- 4) 검증
do $$
declare
  bad_count int;
begin
  select count(*) into bad_count from public.memberships
  where role not in ('staff','lead','admin','ceo','lawyer','customer');
  if bad_count > 0 then
    raise exception 'memberships.role migration failed: % rows have invalid role', bad_count;
  end if;
end $$;

commit;

-- ════════════════════════════════════════════════════════════
-- 롤백 (필요 시 별도 실행)
-- ════════════════════════════════════════════════════════════
-- begin;
-- update public.memberships set role = 'manager' where role = 'lead';
-- alter table public.memberships drop constraint memberships_role_check;
-- alter table public.memberships add constraint memberships_role_check
--   check (role in ('admin','manager','inspector','viewer'));
-- alter table public.memberships drop column if exists expires_at;
-- commit;
