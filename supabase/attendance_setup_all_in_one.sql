-- ════════════════════════════════════════════════════════════
-- 잠사플레이팜 BLE 출퇴근 시스템 — 전체 설치 (테이블 + 뷰 + RLS)
-- 작성일: 2026-05-19
-- ════════════════════════════════════════════════════════════
-- 사용법:
--   1. Supabase 대시보드 → SQL Editor → New Query
--   2. 이 파일 전체 복사 → 붙여넣기 → Run
--   3. 이후 /attendance 페이지에서 ANON KEY 입력 시 정상 동작
--
-- 안전성:
--   - 모든 구문이 IF NOT EXISTS / OR REPLACE / DROP IF EXISTS 패턴
--   - 여러 번 실행해도 데이터 손실 없음
-- ════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────
-- 1. 부서 마스터 (beacon_dept)
-- ───────────────────────────────────────────────
create table if not exists public.beacon_dept (
  id          smallserial primary key,
  name        text not null unique,
  beacon_uuid text,
  created_at  timestamptz default now()
);

insert into public.beacon_dept (id, name) values
  (1, '관리부'),
  (2, '시설부'),
  (3, '외국인')
on conflict (id) do nothing;

-- 시퀀스 재정렬 (수동 id 입력 후 nextval 보정)
select setval(pg_get_serial_sequence('public.beacon_dept','id'),
              greatest((select coalesce(max(id),1) from public.beacon_dept), 1));

-- ───────────────────────────────────────────────
-- 2. 직원 마스터 (staff)
-- ───────────────────────────────────────────────
create table if not exists public.staff (
  id            bigserial primary key,
  name          text not null unique,
  dept_id       smallint references public.beacon_dept(id) on delete set null,
  beacon_id     text,
  phone         text,
  visa_type     text,
  visa_expiry   date,
  is_active     boolean default true,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists staff_dept_idx     on public.staff(dept_id);
create index if not exists staff_beacon_idx   on public.staff(beacon_id);
create index if not exists staff_active_idx   on public.staff(is_active);

-- updated_at 자동 갱신
create or replace function public.set_staff_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists staff_updated_at on public.staff;
create trigger staff_updated_at
  before update on public.staff
  for each row execute function public.set_staff_updated_at();

-- ───────────────────────────────────────────────
-- 3. 출퇴근 기록 (attendance)
-- ───────────────────────────────────────────────
create table if not exists public.attendance (
  id              bigserial primary key,
  staff_id        bigint not null references public.staff(id) on delete cascade,
  checked_in_at   timestamptz not null default now(),
  checked_out_at  timestamptz,
  work_date       date generated always as ((checked_in_at at time zone 'Asia/Seoul')::date) stored,
  source          text default 'manual',  -- 'manual' / 'beacon' / 'qr'
  beacon_id       text,
  note            text,
  created_at      timestamptz default now()
);

create index if not exists attendance_staff_idx       on public.attendance(staff_id);
create index if not exists attendance_checkin_idx     on public.attendance(checked_in_at desc);
create index if not exists attendance_workdate_idx    on public.attendance(work_date desc);
create index if not exists attendance_open_idx        on public.attendance(staff_id) where checked_out_at is null;

-- ───────────────────────────────────────────────
-- 4. 결근 기록 (absence_records)
-- ───────────────────────────────────────────────
create table if not exists public.absence_records (
  id          bigserial primary key,
  staff_id    bigint not null references public.staff(id) on delete cascade,
  date        date not null,
  reason      text,
  approved_by text,
  created_at  timestamptz default now(),
  unique (staff_id, date)
);

-- ───────────────────────────────────────────────
-- 5. 뷰: 오늘 출퇴근 (v_attendance_today)
-- ───────────────────────────────────────────────
create or replace view public.v_attendance_today as
select
  a.id,
  a.staff_id,
  s.name           as staff_name,
  s.dept_id,
  d.name           as dept_name,
  s.beacon_id,
  a.checked_in_at,
  a.checked_out_at,
  case
    when a.checked_out_at is null then 'working'
    else 'done'
  end as status,
  extract(epoch from (coalesce(a.checked_out_at, now()) - a.checked_in_at)) / 3600.0 as hours
from public.attendance a
join public.staff s on s.id = a.staff_id
left join public.beacon_dept d on d.id = s.dept_id
where (a.checked_in_at at time zone 'Asia/Seoul')::date
      = (now() at time zone 'Asia/Seoul')::date
order by a.checked_in_at desc;

-- ───────────────────────────────────────────────
-- 6. 뷰: 외국인 직원 비자 (v_foreign_workers)
-- ───────────────────────────────────────────────
create or replace view public.v_foreign_workers as
select
  s.id,
  s.name,
  d.name        as dept_name,
  s.visa_type,
  s.visa_expiry,
  (s.visa_expiry - current_date) as days_until_expiry,
  case
    when s.visa_expiry is null then 'none'
    when s.visa_expiry < current_date then 'expired'
    when s.visa_expiry <= current_date + 30 then 'critical'
    when s.visa_expiry <= current_date + 90 then 'warning'
    else 'ok'
  end as visa_status
from public.staff s
left join public.beacon_dept d on d.id = s.dept_id
where s.visa_type is not null
  and s.is_active = true
order by s.visa_expiry asc nulls last;

-- ───────────────────────────────────────────────
-- 7. 뷰: 근무시간 집계 (v_work_hours)
-- ───────────────────────────────────────────────
create or replace view public.v_work_hours as
select
  a.staff_id,
  s.name        as name,
  a.work_date,
  sum(
    extract(epoch from (coalesce(a.checked_out_at, now()) - a.checked_in_at)) / 3600.0
  ) as hours
from public.attendance a
join public.staff s on s.id = a.staff_id
where a.work_date >= current_date - 7
group by a.staff_id, s.name, a.work_date
order by a.work_date desc, s.name asc;

-- ───────────────────────────────────────────────
-- 8. 뷰: 일별 요약 (v_daily_summary)
-- ───────────────────────────────────────────────
create or replace view public.v_daily_summary as
select
  a.work_date,
  count(distinct a.staff_id)                                        as total_in,
  count(distinct a.staff_id) filter (where a.checked_out_at is null) as still_working,
  count(distinct a.staff_id) filter (where a.checked_out_at is not null) as checked_out,
  round(
    sum(extract(epoch from (coalesce(a.checked_out_at, now()) - a.checked_in_at)) / 3600.0)::numeric,
    1
  ) as total_hours
from public.attendance a
group by a.work_date
order by a.work_date desc;

-- ───────────────────────────────────────────────
-- 9. RPC: 자동 퇴근 (auto_close_stale_attendance)
-- ───────────────────────────────────────────────
create or replace function public.auto_close_stale_attendance()
returns integer
language plpgsql
security definer
as $$
declare
  v_closed integer;
begin
  with closed as (
    update public.attendance
       set checked_out_at = (date_trunc('day', checked_in_at at time zone 'Asia/Seoul')
                             + interval '23 hours 59 minutes')
                            at time zone 'Asia/Seoul'
     where checked_out_at is null
       and (checked_in_at at time zone 'Asia/Seoul')::date
           < (now() at time zone 'Asia/Seoul')::date
    returning 1
  )
  select count(*) into v_closed from closed;
  return v_closed;
end $$;

-- ════════════════════════════════════════════════════════════
-- 10. RLS (Row Level Security) — anon 키로 페이지 동작 허용
-- ════════════════════════════════════════════════════════════
-- 보안 메모:
--   - attendance 페이지는 ANON KEY 로 동작 (브라우저에 노출됨)
--   - 사내망/태블릿 키오스크 운영 가정 → anon 에 read/write 허용
--   - 외부 노출 위험이 있으면 별도 인증 추가 권장
-- ════════════════════════════════════════════════════════════

alter table public.beacon_dept       enable row level security;
alter table public.staff             enable row level security;
alter table public.attendance        enable row level security;
alter table public.absence_records   enable row level security;

-- beacon_dept: 모두 read
drop policy if exists "anon read beacon_dept" on public.beacon_dept;
create policy "anon read beacon_dept" on public.beacon_dept
  for select using (true);

-- staff: 모두 read (개인정보 노출이 우려되면 별도 인증 추가 권장)
drop policy if exists "anon read staff" on public.staff;
create policy "anon read staff" on public.staff
  for select using (true);

drop policy if exists "anon write staff" on public.staff;
create policy "anon write staff" on public.staff
  for all using (true) with check (true);

-- attendance: anon 이 INSERT / UPDATE / SELECT 가능 (출퇴근 체크인용)
drop policy if exists "anon read attendance" on public.attendance;
create policy "anon read attendance" on public.attendance
  for select using (true);

drop policy if exists "anon insert attendance" on public.attendance;
create policy "anon insert attendance" on public.attendance
  for insert with check (true);

drop policy if exists "anon update attendance" on public.attendance;
create policy "anon update attendance" on public.attendance
  for update using (true) with check (true);

-- absence_records: 모두 read
drop policy if exists "anon read absence" on public.absence_records;
create policy "anon read absence" on public.absence_records
  for select using (true);

-- ════════════════════════════════════════════════════════════
-- 11. 부서 시드 직원 1명 (테스트용, 운영 시 staff_seed.sql 로 교체)
-- ════════════════════════════════════════════════════════════
insert into public.staff (name, dept_id, beacon_id)
values ('이경연', 1, null)
on conflict (name) do nothing;

-- ════════════════════════════════════════════════════════════
-- 12. 검증 쿼리
-- ════════════════════════════════════════════════════════════
select '✓ 설치 완료' as status;
select 'beacon_dept' as name, count(*) as rows from public.beacon_dept
union all select 'staff', count(*) from public.staff
union all select 'attendance', count(*) from public.attendance
union all select 'absence_records', count(*) from public.absence_records
union all select 'v_attendance_today (view)', count(*) from public.v_attendance_today
union all select 'v_foreign_workers (view)', count(*) from public.v_foreign_workers
union all select 'v_work_hours (view)', count(*) from public.v_work_hours
union all select 'v_daily_summary (view)', count(*) from public.v_daily_summary
order by name;

-- ════════════════════════════════════════════════════════════
-- 끝. 이제 /attendance 페이지가 정상 동작합니다.
-- 직원 명단은 supabase/staff_seed.sql 을 별도 실행.
-- ════════════════════════════════════════════════════════════
