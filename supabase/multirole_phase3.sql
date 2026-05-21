-- ════════════════════════════════════════════════════════════
-- Phase 3 — 동의·정정·고객 포털 (Tier 1·2·3)
-- ════════════════════════════════════════════════════════════
-- 설계 문서 §3.2, §3.4, §3.5, §4.3, §4.4, §11.1 참고.
-- 실행 전: Phase 1·2 적용 완료 필수.
-- ════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════
-- 1. consent_records — 위치정보 동의 (위치정보법 §18)
-- ═══════════════════════════════════════════
create table if not exists public.consent_records (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  staff_id uuid not null references auth.users(id) on delete cascade,
  consent_version text not null,                  -- 'v3.2' 등
  consent_text_hash text not null,                -- 동의 문구 SHA-256 (변조 방지)
  scope jsonb not null,                           -- ['gps','ble','work_hours_only']
  agreed_at timestamptz not null default now(),
  agreed_ip inet,
  agreed_user_agent text,
  withdrawn_at timestamptz,
  withdraw_reason text,
  created_at timestamptz default now()
);
create index if not exists consent_staff_idx on public.consent_records (staff_id, agreed_at desc);
create index if not exists consent_org_idx on public.consent_records (org_id, agreed_at desc);

alter table public.consent_records enable row level security;

drop policy if exists consent_own_read on public.consent_records;
create policy consent_own_read on public.consent_records
  for select to authenticated using (auth.uid() = staff_id);

drop policy if exists consent_audit_read on public.consent_records;
create policy consent_audit_read on public.consent_records
  for select to authenticated using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.org_id = consent_records.org_id
              and m.role in ('admin','lawyer')
              and (m.expires_at is null or m.expires_at > now()))
  );

drop policy if exists consent_own_insert on public.consent_records;
create policy consent_own_insert on public.consent_records
  for insert to authenticated with check (auth.uid() = staff_id);

-- 철회는 본인만, withdrawn_at 만 set 가능
drop policy if exists consent_own_withdraw on public.consent_records;
create policy consent_own_withdraw on public.consent_records
  for update to authenticated using (auth.uid() = staff_id)
  with check (auth.uid() = staff_id and withdrawn_at is not null);

-- ═══════════════════════════════════════════
-- 2. attendance_corrections — 출퇴근 정정 요청 (근로기준법 §42)
-- ═══════════════════════════════════════════
create table if not exists public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  staff_id uuid not null references auth.users(id),
  date date not null,
  field text not null check (field in ('check_in','check_out','break_time')),
  value_before time,
  value_after time not null,
  reason text not null check (char_length(reason) >= 10),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  reviewed_note text,
  created_at timestamptz default now()
);
create index if not exists corr_staff_idx on public.attendance_corrections (staff_id, created_at desc);
create index if not exists corr_status_idx on public.attendance_corrections (org_id, status, created_at desc);

alter table public.attendance_corrections enable row level security;

drop policy if exists corr_own_all on public.attendance_corrections;
create policy corr_own_all on public.attendance_corrections
  for all to authenticated
  using (auth.uid() = staff_id)
  with check (auth.uid() = staff_id);

drop policy if exists corr_lead_read on public.attendance_corrections;
create policy corr_lead_read on public.attendance_corrections
  for select to authenticated using (
    exists (
      select 1 from public.memberships m1
      join public.memberships m2
        on m1.org_id = m2.org_id
       and (m1.dept = m2.dept or m1.dept is null)
      where m1.user_id = auth.uid()
        and m1.role = 'lead'
        and m2.user_id = attendance_corrections.staff_id
    )
  );

drop policy if exists corr_admin_all on public.attendance_corrections;
create policy corr_admin_all on public.attendance_corrections
  for all to authenticated using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.org_id = attendance_corrections.org_id
              and m.role in ('admin','lawyer')
              and (m.expires_at is null or m.expires_at > now()))
  );

-- ═══════════════════════════════════════════
-- 3. service_sessions — 고객 서비스 세션 (Tier 1·2·3 공통)
-- ═══════════════════════════════════════════
create table if not exists public.service_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  customer_org text not null,
  customer_contact_email text,
  site_name text not null,
  scheduled_at timestamptz not null,
  scheduled_duration_min int not null default 60,
  assigned_staff_count int default 0,
  status text not null default 'scheduled'
    check (status in ('scheduled','arrived','started','completed','delayed','cancelled')),
  delay_min int default 0,
  issue_count int default 0,
  actual_arrival_at timestamptz,
  customer_view_token text unique not null,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);
create index if not exists svc_token_idx on public.service_sessions (customer_view_token);
create index if not exists svc_org_time_idx on public.service_sessions (org_id, scheduled_at desc);
create index if not exists svc_customer_org_idx on public.service_sessions (customer_org, scheduled_at desc);

alter table public.service_sessions enable row level security;

-- Tier 3: 정식 고객 계정 로그인 시 본인 고객사 세션만
drop policy if exists svc_customer_account_read on public.service_sessions;
create policy svc_customer_account_read on public.service_sessions
  for select to authenticated using (
    exists (
      select 1 from public.customer_org_members com
      where com.user_id = auth.uid()
        and com.customer_org = service_sessions.customer_org
    )
  );

-- 운영진(admin/lead/lawyer)은 본인 조직 세션 조회
drop policy if exists svc_org_internal_read on public.service_sessions;
create policy svc_org_internal_read on public.service_sessions
  for select to authenticated using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.org_id = service_sessions.org_id
              and m.role in ('admin','lead','lawyer')
              and (m.expires_at is null or m.expires_at > now()))
  );

-- Tier 1·2 토큰 기반 조회는 RPC 함수로
drop function if exists public.get_session_by_token(text);
create or replace function public.get_session_by_token(p_token text)
returns table (
  id uuid,
  customer_org text,
  site_name text,
  scheduled_at timestamptz,
  scheduled_duration_min int,
  status text,
  delay_min int,
  issue_count int,
  actual_arrival_at timestamptz,
  assigned_staff_count int
)
language sql security definer
set search_path = public
as $$
  select id, customer_org, site_name, scheduled_at, scheduled_duration_min,
         status, delay_min, issue_count, actual_arrival_at, assigned_staff_count
  from public.service_sessions
  where customer_view_token = p_token
    and created_at > now() - interval '90 days';
$$;
revoke all on function public.get_session_by_token(text) from public;
grant execute on function public.get_session_by_token(text) to anon, authenticated;

-- ═══════════════════════════════════════════
-- 4. customer_otp_log — Tier 2 OTP 발송 기록
-- ═══════════════════════════════════════════
create table if not exists public.customer_otp_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.service_sessions(id) on delete cascade,
  email text not null,
  code_hash text not null,                        -- SHA-256 (평문 저장 금지)
  purpose text not null,                          -- 'detail_view' / 'photo_view'
  sent_at timestamptz default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts int default 0,
  ip inet,
  user_agent text
);
create index if not exists otp_session_idx on public.customer_otp_log (session_id, sent_at desc);
create index if not exists otp_email_idx on public.customer_otp_log (email, sent_at desc);

alter table public.customer_otp_log enable row level security;
-- 직접 SELECT 차단 (service-role 만 사용)
revoke select on public.customer_otp_log from authenticated, anon;

-- ═══════════════════════════════════════════
-- 5. customer_org_members — Tier 3 정식 고객 계정
-- ═══════════════════════════════════════════
create table if not exists public.customer_org_members (
  user_id uuid references auth.users(id) on delete cascade,
  customer_org text not null,
  is_primary boolean default false,
  created_at timestamptz default now(),
  primary key (user_id, customer_org)
);
create index if not exists com_customer_idx on public.customer_org_members (customer_org);

alter table public.customer_org_members enable row level security;

drop policy if exists com_own_read on public.customer_org_members;
create policy com_own_read on public.customer_org_members
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists com_admin_all on public.customer_org_members;
create policy com_admin_all on public.customer_org_members
  for all to authenticated using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.role = 'admin')
  );

commit;

-- ════════════════════════════════════════════════════════════
-- 시연용 데이터 (선택 — 운영 적용 시 제거)
-- ════════════════════════════════════════════════════════════
insert into public.service_sessions (
  org_id, customer_org, customer_contact_email, site_name,
  scheduled_at, scheduled_duration_min, status, delay_min, issue_count,
  actual_arrival_at, assigned_staff_count, customer_view_token
) values
('jamsa', '청주시 시설관리공단', 'demo@cheongju.go.kr', '한국잠사박물관',
 now() + interval '2 hours', 180, 'arrived', 0, 0,
 now() - interval '8 minutes', 2, 'DEMO-1234')
on conflict (customer_view_token) do update set status = excluded.status;

-- ════════════════════════════════════════════════════════════
-- 롤백
-- ════════════════════════════════════════════════════════════
-- begin;
-- drop function if exists public.get_session_by_token(text);
-- drop table if exists public.customer_org_members;
-- drop table if exists public.customer_otp_log;
-- drop table if exists public.service_sessions;
-- drop table if exists public.attendance_corrections;
-- drop table if exists public.consent_records;
-- commit;
