-- ═══════════════════════════════════════════════════════════════
-- 비콘 게이트웨이 인프라 (2026-05-25)
-- 정찬주 전무님 통보: 박물관/키즈카페/누에쉼터/온실 4곳 설치 완료
--                     단체식당/외부매표소/냉동창고/온실의 창고/수영장 5곳 설치 예정
-- 게이트웨이는 무선 AP 와 함께 설치, 비콘은 직원이 휴대
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────
-- 1. 게이트웨이 인프라 (물리 장비 정보 + 설치 상태)
--    gateway_zone_map 는 detection→zone 매핑용 (이미 존재),
--    여기서는 설치 위치/상태/AP 정보를 별도 관리
-- ───────────────────────────────────────────────
create table if not exists public.beacon_gateways (
  id              bigserial primary key,
  gateway_serial  text unique,                   -- 게이트웨이 시리얼 (실제 수신 시 매핑 키)
  spot_id         text not null,                 -- BASE_ZONES 의 spot id (bldg/kidscafe/dome 등)
  spot_name       text not null,                 -- 설치 위치 한글명
  install_status  text not null default 'planned',  -- planned | active | offline | maintenance
  is_outdoor      boolean default false,         -- 야외 설치 여부 (단체식당/외부매표소 등)
  paired_ap_mac   text,                          -- 함께 설치된 무선 AP MAC (선택)
  paired_ap_ssid  text,                          -- 무선 AP SSID
  installed_at    timestamptz,                   -- 설치 완료 시각
  last_seen_at    timestamptz,                   -- 마지막 신호 수신 시각
  zone_id         text,                          -- gateway_zone_map zone_id 와 연결
  cctv_channel    integer,                       -- 인접 CCTV 채널 (있으면)
  lat             numeric(10,7),                 -- 위치 좌표
  lng             numeric(10,7),
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists bg_status_idx  on public.beacon_gateways(install_status);
create index if not exists bg_spot_idx    on public.beacon_gateways(spot_id);
create index if not exists bg_outdoor_idx on public.beacon_gateways(is_outdoor) where is_outdoor = true;

-- ───────────────────────────────────────────────
-- 2. 직원-비콘 매핑 (각 직원이 가지고 다니는 비콘 ID)
-- ───────────────────────────────────────────────
create table if not exists public.staff_beacons (
  id              bigserial primary key,
  staff_id        bigint references public.staff(id) on delete cascade,
  beacon_uuid     text not null,                 -- BLE 비콘의 MAC 또는 UUID
  beacon_label    text,                          -- 비콘 라벨 (예: "BEACON-A1", "직원01")
  beacon_type     text default 'wearable',       -- wearable | badge | keychain
  issued_at       timestamptz default now(),
  returned_at     timestamptz,                   -- null = 현재 휴대 중
  is_active       boolean generated always as (returned_at is null) stored,
  battery_pct     integer,                       -- 마지막 측정 배터리 %
  notes           text,
  created_at      timestamptz default now()
);

create unique index if not exists sb_active_unique
  on public.staff_beacons(beacon_uuid) where returned_at is null;
create index if not exists sb_staff_idx
  on public.staff_beacons(staff_id) where returned_at is null;

-- ───────────────────────────────────────────────
-- 3. RLS 정책
-- ───────────────────────────────────────────────
alter table public.beacon_gateways enable row level security;
alter table public.staff_beacons   enable row level security;

drop policy if exists "bg_select_all" on public.beacon_gateways;
create policy "bg_select_all" on public.beacon_gateways for select using (true);

drop policy if exists "bg_modify_auth" on public.beacon_gateways;
create policy "bg_modify_auth" on public.beacon_gateways for all
  to authenticated using (true) with check (true);

drop policy if exists "sb_select_all" on public.staff_beacons;
create policy "sb_select_all" on public.staff_beacons for select using (true);

drop policy if exists "sb_modify_auth" on public.staff_beacons;
create policy "sb_modify_auth" on public.staff_beacons for all
  to authenticated using (true) with check (true);

-- Realtime 활성화
alter publication supabase_realtime add table public.beacon_gateways;
alter publication supabase_realtime add table public.staff_beacons;

-- ───────────────────────────────────────────────
-- 4. 초기 시드 — 정찬주 전무님 2026-05-25 통보 기준
-- ───────────────────────────────────────────────

-- 4-1. 설치 완료 4곳 (실내)
insert into public.beacon_gateways
  (spot_id, spot_name, install_status, is_outdoor, installed_at, lat, lng, notes)
values
  ('bldg',     '박물관',     'active', false, now(), 36.63833, 127.38288, '본관 1층 로비 - 무선AP 동시 설치'),
  ('kidscafe', '키즈카페',   'active', false, now(), 36.63832, 127.38255, '실내 키즈카페'),
  ('dome',     '누에쉼터',   'active', false, now(), 36.63862, 127.38260, '누에 체험 돔'),
  ('gh',       '온실',       'active', false, now(), 36.63850, 127.38275, '온실 본동')
on conflict do nothing;

-- 4-2. 설치 예정 5곳 (야외 - 매표소/창고/수영장 등)
insert into public.beacon_gateways
  (spot_id, spot_name, install_status, is_outdoor, lat, lng, notes)
values
  ('basic',    '단체식당',         'planned', true, 36.63852, 127.38258, '야외 단체식당 입구'),
  ('basic',    '외부매표소',       'planned', true, 36.63852, 127.38245, '단체식당 옆 매표소 (별도 부지)'),
  ('basic',    '냉동창고',         'planned', true, 36.63848, 127.38252, '식당동 후면 냉동창고'),
  ('gh',       '온실의 창고',      'planned', true, 36.63848, 127.38278, '온실 부속 창고'),
  ('water',    '수영장',           'planned', true, 36.63838, 127.38315, '여름 물놀이장')
on conflict do nothing;

-- ───────────────────────────────────────────────
-- 5. 진단 뷰 — 현황을 한눈에
-- ───────────────────────────────────────────────
create or replace view public.v_gateway_status as
select
  bg.id,
  bg.spot_name,
  bg.spot_id,
  bg.install_status,
  bg.is_outdoor,
  bg.gateway_serial,
  bg.installed_at,
  bg.last_seen_at,
  case
    when bg.install_status != 'active' then bg.install_status
    when bg.last_seen_at is null then 'never_seen'
    when bg.last_seen_at > now() - interval '5 minutes' then 'online'
    when bg.last_seen_at > now() - interval '1 hour'    then 'idle'
    else 'offline'
  end as live_status,
  (
    select count(*) from public.beacon_detections d
    where d.gateway_serial = bg.gateway_serial
      and d.detected_at > now() - interval '24 hours'
  ) as detections_24h,
  bg.lat, bg.lng, bg.notes
from public.beacon_gateways bg
order by
  case bg.install_status when 'active' then 1 when 'planned' then 2 else 3 end,
  bg.spot_name;

-- ───────────────────────────────────────────────
-- 6. 게이트웨이 시리얼 수신 시 자동 last_seen_at 갱신 트리거
-- ───────────────────────────────────────────────
create or replace function public.touch_gateway_lastseen() returns trigger as $$
begin
  update public.beacon_gateways
     set last_seen_at = new.detected_at,
         updated_at   = now()
   where gateway_serial = new.gateway_serial;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_gateway on public.beacon_detections;
create trigger trg_touch_gateway
  after insert on public.beacon_detections
  for each row execute function public.touch_gateway_lastseen();

comment on table  public.beacon_gateways is '비콘 게이트웨이 인프라 (정찬주 전무 2026-05-25 통보 기준)';
comment on table  public.staff_beacons   is '직원이 휴대하는 BLE 비콘 매핑 — 위치 추적의 기준';
comment on view   public.v_gateway_status is '게이트웨이 실시간 현황 — install_status + last_seen_at + 24h detections';
