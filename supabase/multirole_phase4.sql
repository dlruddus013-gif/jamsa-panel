-- ════════════════════════════════════════════════════════════
-- Phase 4 — 감사 패키지 + 노무사 발송 + 보존 정책
-- ════════════════════════════════════════════════════════════
-- 설계 §11.2 (노무사 2-경로) 참고.
-- 실행 전: Phase 1·2·3 적용 완료 필수.
-- ════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════
-- 1. lawyer_recipients — 정기 감사 패키지 수신자
-- ═══════════════════════════════════════════
create table if not exists public.lawyer_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  name text not null,
  email text not null,
  pgp_public_key text,                        -- 있으면 PGP, 없으면 zip 패스워드
  zip_password_hint text,
  active boolean default true,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);
create index if not exists lr_org_active_idx on public.lawyer_recipients (org_id) where active;

alter table public.lawyer_recipients enable row level security;

drop policy if exists lr_admin_lawyer_read on public.lawyer_recipients;
create policy lr_admin_lawyer_read on public.lawyer_recipients
  for select to authenticated using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.org_id = lawyer_recipients.org_id
              and m.role in ('admin','lawyer'))
  );

drop policy if exists lr_admin_write on public.lawyer_recipients;
create policy lr_admin_write on public.lawyer_recipients
  for all to authenticated using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.org_id = lawyer_recipients.org_id
              and m.role = 'admin')
  );

-- ═══════════════════════════════════════════
-- 2. audit_package_log — 발송 기록
-- ═══════════════════════════════════════════
create table if not exists public.audit_package_log (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  period_start date not null,
  period_end date not null,
  generated_at timestamptz default now(),
  generated_by uuid references auth.users(id),       -- null이면 cron 자동 생성
  recipient_email text not null,
  recipient_name text,
  encryption_method text not null check (encryption_method in ('zip_password','pgp_pubkey','none')),
  package_sha256 text not null,                       -- 발송본 무결성 증명
  package_size_bytes int,
  delivered_at timestamptz,
  delivery_status text default 'pending'              -- pending/sent/failed/bounced
    check (delivery_status in ('pending','sent','failed','bounced')),
  delivery_error text,
  payload_summary jsonb,                              -- {consent_count, log_count, ...}
  unique (org_id, period_start, recipient_email)
);
create index if not exists apl_org_period_idx on public.audit_package_log (org_id, period_start desc);

alter table public.audit_package_log enable row level security;

drop policy if exists apl_admin_lawyer_read on public.audit_package_log;
create policy apl_admin_lawyer_read on public.audit_package_log
  for select to authenticated using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.org_id = audit_package_log.org_id
              and m.role in ('admin','lawyer'))
  );

revoke update, delete on public.audit_package_log from authenticated, anon;

-- ═══════════════════════════════════════════
-- 3. 보존 정책 함수 — 만료 데이터 자동 파기
-- ═══════════════════════════════════════════
-- 설계 §6.1: 원본 좌표 90일 → 파기. 외부 cron(매일 03:00) 또는
-- pg_cron extension 사용 시 등록.
create or replace function public.purge_expired_locations()
returns table (purged_count int) language plpgsql as $$
declare
  cutoff timestamptz := now() - interval '90 days';
  deleted_count int;
begin
  delete from public.staff_locations where updated_at < cutoff;
  get diagnostics deleted_count = row_count;

  insert into public.audit_logs (org_id, action, resource, payload)
  values ('jamsa', 'RETENTION_PURGE', 'staff_locations',
          jsonb_build_object('cutoff', cutoff, 'purged_count', deleted_count));

  return query select deleted_count;
end $$;

-- 접근 로그는 5년 보존, 그 후 archive 처리는 외부 스크립트로
-- (DELETE는 RLS로 차단되어 있으므로 service-role에서 별도 archive 테이블로 이동)

commit;

-- ════════════════════════════════════════════════════════════
-- 시연용 노무사 수신자 (운영 적용 시 제거)
-- ════════════════════════════════════════════════════════════
insert into public.lawyer_recipients (org_id, name, email, active)
values ('jamsa', '시연용 노무사', 'demo-lawyer@example.com', true)
on conflict do nothing;

-- ════════════════════════════════════════════════════════════
-- 롤백
-- ════════════════════════════════════════════════════════════
-- begin;
-- drop function if exists public.purge_expired_locations();
-- drop table if exists public.audit_package_log;
-- drop table if exists public.lawyer_recipients;
-- commit;
