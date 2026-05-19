-- ════════════════════════════════════════════════════════════
-- 잠사플레이팜 · 실시간 위치 추적 + 행동 분석 + 일과별 로그
-- (BLE 게이트웨이 → 비콘 감지 → 구역 추정 → CCTV 연동)
-- 작성일: 2026-05-20
-- ════════════════════════════════════════════════════════════
-- 전제: attendance_setup_all_in_one.sql 이 먼저 실행되어 있어야 함
--       (staff, beacon_dept, attendance 테이블 존재)
-- ════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────
-- 0. 기존 추적 스키마 정리
-- ───────────────────────────────────────────────
drop view  if exists public.v_current_presence cascade;
drop view  if exists public.v_daily_activity   cascade;
drop view  if exists public.v_zone_occupancy   cascade;
drop trigger if exists trg_after_detection on public.beacon_detections;
drop function if exists public.process_beacon_detection() cascade;
drop function if exists public.close_stale_presence(integer) cascade;
drop table if exists public.activity_log      cascade;
drop table if exists public.presence_events   cascade;
drop table if exists public.beacon_detections cascade;
drop table if exists public.gateway_zone_map  cascade;

-- ───────────────────────────────────────────────
-- 1. 게이트웨이 ↔ 구역 매핑
-- ───────────────────────────────────────────────
create table public.gateway_zone_map (
  gateway_serial   text primary key,
  zone_id          text not null,
  zone_name        text not null,
  cctv_channel     integer,
  cctv_url         text,                    -- 옵셔널: 채널 대신 URL 직접
  dwell_threshold_min integer default 2,    -- 같은 구역 머무름 판단 임계 (분)
  notes            text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index gateway_zone_zone_idx on public.gateway_zone_map(zone_id);

-- ───────────────────────────────────────────────
-- 2. 비콘 감지 raw 로그 (게이트웨이 webhook 데이터)
-- ───────────────────────────────────────────────
create table public.beacon_detections (
  id              bigserial primary key,
  gateway_serial  text not null,
  beacon_uuid     text not null,
  beacon_name     text,
  rssi            integer,
  tx_power        integer,
  raw             jsonb,
  detected_at     timestamptz not null default now(),
  created_at      timestamptz default now()
);

create index detection_gw_idx     on public.beacon_detections(gateway_serial);
create index detection_beacon_idx on public.beacon_detections(beacon_uuid);
create index detection_time_idx   on public.beacon_detections(detected_at desc);
create index detection_gw_time    on public.beacon_detections(gateway_serial, detected_at desc);

-- ───────────────────────────────────────────────
-- 3. 위치 이벤트 (구역 입장 ~ 퇴장)
-- ───────────────────────────────────────────────
create table public.presence_events (
  id               bigserial primary key,
  staff_id         bigint references public.staff(id) on delete set null,
  beacon_uuid      text not null,
  zone_id          text,
  zone_name        text,
  gateway_serial   text,
  cctv_channel     integer,
  entered_at       timestamptz not null default now(),
  exited_at        timestamptz,             -- null = 현재 머무는 중
  duration_sec     integer generated always as
                     (case when exited_at is null then null
                           else extract(epoch from (exited_at - entered_at))::int end) stored,
  max_rssi         integer,
  detection_count  integer default 1,
  is_active        boolean generated always as (exited_at is null) stored,
  notes            text,
  created_at       timestamptz default now()
);

create index pe_staff_time    on public.presence_events(staff_id, entered_at desc);
create index pe_zone_time     on public.presence_events(zone_id, entered_at desc);
create index pe_active        on public.presence_events(staff_id) where exited_at is null;
create index pe_beacon_active on public.presence_events(beacon_uuid) where exited_at is null;

-- ───────────────────────────────────────────────
-- 4. 행동 분석 로그 (일과별 로그)
-- ───────────────────────────────────────────────
create table public.activity_log (
  id                bigserial primary key,
  staff_id          bigint references public.staff(id) on delete set null,
  staff_name        text,
  zone_id           text,
  zone_name         text,
  activity_type     text not null,    -- CHECK_IN, ZONE_ENTER, ZONE_EXIT, ZONE_DWELL, TRANSIT, CHECK_OUT, IDLE_ALERT
  inferred_behavior text,             -- 한국어 자연어 설명
  duration_sec      integer,
  rssi              integer,
  cctv_channel      integer,
  cctv_snapshot_url text,             -- 옵셔널 CCTV 스냅샷 URL
  payload           jsonb,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz default now()
);

create index al_staff_time   on public.activity_log(staff_id, occurred_at desc);
create index al_type_time    on public.activity_log(activity_type, occurred_at desc);
create index al_today        on public.activity_log(occurred_at desc);

-- ───────────────────────────────────────────────
-- 5. 핵심 함수: 비콘 감지 → presence_events / activity_log 변환
-- ───────────────────────────────────────────────
create or replace function public.process_beacon_detection()
returns trigger
language plpgsql
security definer
as $$
declare
  v_staff_id   bigint;
  v_staff_name text;
  v_zone_id    text;
  v_zone_name  text;
  v_cctv_ch    integer;
  v_dwell_min  integer;
  v_active     public.presence_events;
  v_inferred   text;
  v_act_id     bigint;
begin
  -- 1) 비콘 → 직원 매핑 (staff.beacon_id 가 detection.beacon_uuid 와 일치)
  select s.id, s.name into v_staff_id, v_staff_name
    from public.staff s
   where s.beacon_id = new.beacon_uuid
   limit 1;

  -- 2) 게이트웨이 → 구역 매핑
  select g.zone_id, g.zone_name, g.cctv_channel, coalesce(g.dwell_threshold_min, 2)
    into v_zone_id, v_zone_name, v_cctv_ch, v_dwell_min
    from public.gateway_zone_map g
   where g.gateway_serial = new.gateway_serial;

  -- 매핑 정보 없으면 raw detection 만 저장하고 끝
  if v_zone_id is null then
    return new;
  end if;

  -- 3) 현재 열린 presence_event 가 같은 비콘+같은 구역에 있는지 확인
  select * into v_active
    from public.presence_events pe
   where pe.beacon_uuid = new.beacon_uuid
     and pe.exited_at is null
   order by pe.entered_at desc
   limit 1;

  if v_active.id is not null and v_active.zone_id = v_zone_id then
    -- 같은 구역에 계속 머무름: detection_count++, max_rssi 갱신
    update public.presence_events
       set detection_count = detection_count + 1,
           max_rssi        = greatest(coalesce(max_rssi, -200), coalesce(new.rssi, -200))
     where id = v_active.id;

    -- 일정 시간(2분)마다 ZONE_DWELL 활동 기록 (스팸 방지)
    if not exists (
      select 1 from public.activity_log al
       where al.staff_id = v_staff_id
         and al.activity_type = 'ZONE_DWELL'
         and al.zone_id = v_zone_id
         and al.occurred_at > now() - (v_dwell_min || ' minutes')::interval
    ) then
      insert into public.activity_log
        (staff_id, staff_name, zone_id, zone_name, activity_type,
         inferred_behavior, duration_sec, rssi, cctv_channel, payload, occurred_at)
      values (
        v_staff_id, v_staff_name, v_zone_id, v_zone_name, 'ZONE_DWELL',
        coalesce(v_staff_name, '미배정') || ' 님이 ' || v_zone_name
          || ' 에서 ' || (extract(epoch from (now() - v_active.entered_at))/60)::int
          || '분째 활동 중 (RSSI ' || coalesce(new.rssi, 0) || ')',
        extract(epoch from (now() - v_active.entered_at))::int,
        new.rssi, v_cctv_ch,
        jsonb_build_object('gateway', new.gateway_serial, 'detection_id', new.id),
        now()
      );
    end if;
    return new;
  end if;

  -- 4) 다른 구역에 있던 경우 → 이전 presence 종료 + TRANSIT 로그
  if v_active.id is not null and v_active.zone_id <> v_zone_id then
    update public.presence_events
       set exited_at = now()
     where id = v_active.id;
    insert into public.activity_log
      (staff_id, staff_name, zone_id, zone_name, activity_type,
       inferred_behavior, duration_sec, rssi, cctv_channel, payload, occurred_at)
    values (
      v_staff_id, v_staff_name, v_active.zone_id, v_active.zone_name, 'ZONE_EXIT',
      coalesce(v_staff_name, '미배정') || ' 님이 ' || v_active.zone_name
        || ' 에서 ' || v_zone_name || ' 으로 이동 (' || (extract(epoch from (now() - v_active.entered_at))/60)::int || '분 머무름)',
      extract(epoch from (now() - v_active.entered_at))::int,
      new.rssi, v_active.cctv_channel,
      jsonb_build_object('gateway', new.gateway_serial, 'detection_id', new.id, 'to_zone', v_zone_id),
      now()
    );
  end if;

  -- 5) 새 구역 입장: 새 presence_event 생성
  v_inferred := coalesce(v_staff_name, '미배정') || ' 님이 ' || v_zone_name
                || ' 에 입장 (RSSI ' || coalesce(new.rssi, 0) || ', 게이트웨이 ' || new.gateway_serial || ')';

  insert into public.presence_events
    (staff_id, beacon_uuid, zone_id, zone_name, gateway_serial, cctv_channel,
     entered_at, max_rssi, detection_count)
  values
    (v_staff_id, new.beacon_uuid, v_zone_id, v_zone_name, new.gateway_serial, v_cctv_ch,
     now(), new.rssi, 1);

  insert into public.activity_log
    (staff_id, staff_name, zone_id, zone_name, activity_type,
     inferred_behavior, rssi, cctv_channel, payload, occurred_at)
  values
    (v_staff_id, v_staff_name, v_zone_id, v_zone_name, 'ZONE_ENTER',
     v_inferred, new.rssi, v_cctv_ch,
     jsonb_build_object('gateway', new.gateway_serial, 'detection_id', new.id),
     now());

  return new;
end $$;

-- 트리거 등록
drop trigger if exists trg_after_detection on public.beacon_detections;
create trigger trg_after_detection
  after insert on public.beacon_detections
  for each row execute function public.process_beacon_detection();

-- ───────────────────────────────────────────────
-- 6. 자동 정리: 일정 시간 이상 감지 안 되면 자동 퇴장
-- ───────────────────────────────────────────────
create or replace function public.close_stale_presence(stale_min integer default 10)
returns integer
language plpgsql
security definer
as $$
declare
  v_closed integer;
begin
  with stale as (
    select pe.id, pe.staff_id, pe.staff_name, pe.zone_id, pe.zone_name,
           pe.entered_at, pe.cctv_channel,
           (select max(detected_at) from public.beacon_detections d
             where d.beacon_uuid = pe.beacon_uuid) as last_seen
      from public.presence_events pe
     where pe.exited_at is null
  ),
  to_close as (
    select * from stale
     where last_seen is null
        or last_seen < now() - (stale_min || ' minutes')::interval
  ),
  closed as (
    update public.presence_events pe
       set exited_at = coalesce(
                         (select max(detected_at) from public.beacon_detections d
                           where d.beacon_uuid = pe.beacon_uuid),
                         pe.entered_at
                       )
      from to_close
     where pe.id = to_close.id
    returning pe.id, to_close.staff_id, to_close.zone_id, to_close.zone_name, to_close.cctv_channel
  ),
  ins as (
    insert into public.activity_log
      (staff_id, zone_id, zone_name, activity_type,
       inferred_behavior, cctv_channel, occurred_at)
    select c.staff_id, c.zone_id, c.zone_name, 'IDLE_ALERT',
           c.zone_name || ' 구역에서 ' || stale_min || '분 이상 비콘 미감지 → 자동 퇴장 처리',
           c.cctv_channel, now()
      from closed c
    returning 1
  )
  select count(*) into v_closed from ins;
  return coalesce(v_closed, 0);
end $$;

-- ───────────────────────────────────────────────
-- 7. 뷰: 현재 위치 (각 직원의 마지막 활성 presence)
-- ───────────────────────────────────────────────
create or replace view public.v_current_presence as
select distinct on (pe.staff_id)
  pe.staff_id,
  s.name           as staff_name,
  s.beacon_id      as beacon_uuid,
  d.name           as dept_name,
  pe.zone_id,
  pe.zone_name,
  pe.gateway_serial,
  pe.cctv_channel,
  pe.entered_at,
  pe.max_rssi,
  pe.detection_count,
  extract(epoch from (now() - pe.entered_at))::int as dwell_sec
from public.presence_events pe
left join public.staff s on s.id = pe.staff_id
left join public.beacon_dept d on d.id = s.dept_id
where pe.exited_at is null
order by pe.staff_id, pe.entered_at desc;

-- ───────────────────────────────────────────────
-- 8. 뷰: 구역별 현재 인원
-- ───────────────────────────────────────────────
create or replace view public.v_zone_occupancy as
select
  pe.zone_id,
  pe.zone_name,
  pe.cctv_channel,
  count(*)                                                                      as people_count,
  array_agg(distinct coalesce(s.name, 'unknown-' || left(pe.beacon_uuid,6)))    as people_names,
  max(pe.entered_at)                                                            as last_entry
from public.presence_events pe
left join public.staff s on s.id = pe.staff_id
where pe.exited_at is null
group by pe.zone_id, pe.zone_name, pe.cctv_channel
order by people_count desc;

-- ───────────────────────────────────────────────
-- 9. 뷰: 일과별 로그 (오늘 + 어제)
-- ───────────────────────────────────────────────
create or replace view public.v_daily_activity as
select
  al.id,
  al.staff_id,
  coalesce(al.staff_name, s.name)        as staff_name,
  d.name                                  as dept_name,
  al.zone_id,
  al.zone_name,
  al.activity_type,
  al.inferred_behavior,
  al.duration_sec,
  al.rssi,
  al.cctv_channel,
  al.occurred_at,
  to_char(al.occurred_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') as occurred_date,
  to_char(al.occurred_at at time zone 'Asia/Seoul', 'HH24:MI:SS') as occurred_time
from public.activity_log al
left join public.staff       s on s.id = al.staff_id
left join public.beacon_dept d on d.id = s.dept_id
where al.occurred_at >= (now() at time zone 'Asia/Seoul')::date - interval '1 day'
order by al.occurred_at desc;

-- ════════════════════════════════════════════════════════════
-- 10. RLS
-- ════════════════════════════════════════════════════════════
alter table public.gateway_zone_map  enable row level security;
alter table public.beacon_detections enable row level security;
alter table public.presence_events   enable row level security;
alter table public.activity_log      enable row level security;

-- gateway_zone_map: 모두 read/write (관리자 전용 UI에서만 호출되므로 OK)
drop policy if exists "anon all gateway_zone_map" on public.gateway_zone_map;
create policy "anon all gateway_zone_map" on public.gateway_zone_map
  for all using (true) with check (true);

-- beacon_detections: anon insert (webhook 이 service_role 또는 anon 으로 호출 가능),
-- 모두 read
drop policy if exists "anon read beacon_detections" on public.beacon_detections;
create policy "anon read beacon_detections" on public.beacon_detections
  for select using (true);
drop policy if exists "anon insert beacon_detections" on public.beacon_detections;
create policy "anon insert beacon_detections" on public.beacon_detections
  for insert with check (true);

-- presence_events / activity_log: 모두 read (trigger 가 자동 insert 하므로 anon insert 불필요)
drop policy if exists "anon read presence" on public.presence_events;
create policy "anon read presence" on public.presence_events
  for select using (true);
drop policy if exists "anon insert presence" on public.presence_events;
create policy "anon insert presence" on public.presence_events
  for insert with check (true);
drop policy if exists "anon update presence" on public.presence_events;
create policy "anon update presence" on public.presence_events
  for update using (true) with check (true);

drop policy if exists "anon read activity_log" on public.activity_log;
create policy "anon read activity_log" on public.activity_log
  for select using (true);
drop policy if exists "anon insert activity_log" on public.activity_log;
create policy "anon insert activity_log" on public.activity_log
  for insert with check (true);

-- ════════════════════════════════════════════════════════════
-- 11. 검증
-- ════════════════════════════════════════════════════════════
select '✓ 위치 추적 시스템 설치 완료' as status;
select 'gateway_zone_map'      as obj, count(*) as rows from public.gateway_zone_map
union all select 'beacon_detections',    count(*) from public.beacon_detections
union all select 'presence_events',      count(*) from public.presence_events
union all select 'activity_log',         count(*) from public.activity_log
union all select 'v_current_presence',   count(*) from public.v_current_presence
union all select 'v_zone_occupancy',     count(*) from public.v_zone_occupancy
union all select 'v_daily_activity',     count(*) from public.v_daily_activity;
