-- ─────────────────────────────────────────────────────────────────
-- HOTFIX (2026-05-20) — v_attendance_today / v_foreign_workers 재생성
--
-- 증상: ERROR 42701: column "beacon_instance" specified more than once
-- 원인: attendance 테이블에도 beacon_instance 가 있고, 이전 뷰가
--       `a.*` + `s.beacon_instance` 를 동시에 select 했기 때문.
--
-- 이 파일만 단독으로 SQL Editor 에 붙여넣고 Run 하면 됩니다.
-- (이미 적용된 다른 마이그레이션과 충돌 없음 — DROP IF EXISTS 만 사용)
-- ─────────────────────────────────────────────────────────────────

drop view if exists public.v_attendance_today cascade;
drop view if exists public.v_foreign_workers  cascade;

-- ── v_attendance_today ────────────────────────────────────────────
create view public.v_attendance_today as
  select a.id,
         a.staff_id,
         a.checked_in_at,
         a.checked_out_at,
         a.raw_rssi,
         a.estimated_distance_m,
         a.beacon_mac          as att_beacon_mac,
         a.beacon_namespace    as att_beacon_namespace,
         a.beacon_instance     as att_beacon_instance,
         a.gateway_id,
         a.dept_code           as att_dept_code,
         s.name                as staff_name,
         s.dept_code           as staff_dept_code,
         s.beacon_instance     as staff_beacon_instance,
         s.contract_type       as staff_contract_type,
         s.visa_type           as staff_visa_type,
         s.visa_expires_at     as staff_visa_expires_at,
         s.country             as staff_country,
         d.name                as dept_name,
         d.color               as dept_color
    from public.attendance a
    left join public.staff       s on s.id   = a.staff_id
    left join public.beacon_dept d on d.code = coalesce(a.dept_code, s.dept_code)
   where a.checked_in_at::date = current_date
   order by a.checked_in_at desc;

-- ── v_foreign_workers ─────────────────────────────────────────────
-- staff.* 안에는 dept_name / dept_color 컬럼이 없으므로 alias 그대로 안전
create view public.v_foreign_workers as
  select s.id,
         s.name,
         s.dept_code,
         s.beacon_namespace,
         s.beacon_instance,
         s.beacon_mac,
         s.contract_type,
         s.visa_type,
         s.visa_expires_at,
         s.insurance_status,
         s.country,
         s.phone,
         s.hire_date,
         s.auth_uid,
         d.name  as dept_name,
         d.color as dept_color,
         case
           when s.visa_expires_at is null                              then 'unknown'
           when s.visa_expires_at <  current_date                       then 'expired'
           when s.visa_expires_at <  current_date + interval '30 day'   then 'warning'
           when s.visa_expires_at <  current_date + interval '90 day'   then 'soon'
           else 'ok'
         end as visa_status
    from public.staff s
    left join public.beacon_dept d on d.code = s.dept_code
   where s.dept_code = 3;

-- 확인
select 'v_attendance_today OK'  as status, count(*) as rows from public.v_attendance_today
union all
select 'v_foreign_workers OK'   as status, count(*) as rows from public.v_foreign_workers;
