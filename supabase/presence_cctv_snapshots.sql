-- ═══════════════════════════════════════════════════════════════
-- 비콘 감지 시 CCTV 자동 캡쳐 + AI 행동 분석 로그 (2026-05-25)
-- 입장 / 행동변화 / 30초주기 / 퇴장 4가지 이벤트
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.presence_cctv_snapshots (
  id                bigserial primary key,
  presence_event_id bigint references public.presence_events(id) on delete cascade,
  staff_id          bigint references public.staff(id) on delete set null,
  staff_name        text,
  beacon_uuid       text,
  zone_id           text,
  zone_name         text,
  gateway_serial    text,
  cctv_channel      integer,

  -- 이벤트 종류
  event_type        text not null
                    check (event_type in ('entry', 'tick_30s', 'behavior_change', 'exit', 'manual')),
  tick_seq          integer,                -- 30초 tick 순번 (entry 직후=1, ...)
  dwell_sec         integer,                -- 입장 후 경과 초

  -- CCTV 데이터
  snapshot_url      text,                   -- CCTV 서버 스냅샷 URL
  snapshot_b64      text,                   -- 옵션: base64 인라인 (작은 썸네일)

  -- AI 분석
  ai_provider       text default 'auto',    -- claude | gpt | auto | none
  ai_summary        text,                   -- 1줄 요약 (한국어)
  ai_detail         text,                   -- 상세 분석 (마크다운)
  ai_actions        jsonb,                  -- [{kind, label, severity}]
  ai_changed_from   text,                   -- 이전 ai_summary (변화 감지용)
  ai_confidence     numeric,                -- 0~1
  ai_elapsed_ms     integer,

  rssi              integer,
  raw               jsonb,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz default now()
);

create index if not exists pcs_event_idx     on public.presence_cctv_snapshots(presence_event_id);
create index if not exists pcs_staff_idx     on public.presence_cctv_snapshots(staff_id, occurred_at desc);
create index if not exists pcs_zone_idx      on public.presence_cctv_snapshots(zone_id, occurred_at desc);
create index if not exists pcs_event_type    on public.presence_cctv_snapshots(event_type, occurred_at desc);
create index if not exists pcs_changes       on public.presence_cctv_snapshots(occurred_at desc)
                                              where event_type in ('entry','behavior_change','exit');

-- ───────────────────────────────────────────────
-- RLS
-- ───────────────────────────────────────────────
alter table public.presence_cctv_snapshots enable row level security;

drop policy if exists "pcs_select_all" on public.presence_cctv_snapshots;
create policy "pcs_select_all" on public.presence_cctv_snapshots for select using (true);

drop policy if exists "pcs_modify_auth" on public.presence_cctv_snapshots;
create policy "pcs_modify_auth" on public.presence_cctv_snapshots for all
  to authenticated using (true) with check (true);

drop policy if exists "pcs_modify_anon" on public.presence_cctv_snapshots;
create policy "pcs_modify_anon" on public.presence_cctv_snapshots for all
  to anon using (true) with check (true);

-- Realtime
alter publication supabase_realtime add table public.presence_cctv_snapshots;

-- ───────────────────────────────────────────────
-- 자동 트리거 : presence_events 입장 (insert) / 퇴장 (exited_at update) 시
--   - cctv 분석은 API 가 처리하지만,
--     자리표시자 행을 즉시 만들어 두면 UI 가 곧바로 카드 표시
-- ───────────────────────────────────────────────
create or replace function public.queue_cctv_snapshot_on_presence() returns trigger as $$
declare
  v_staff_name text;
  v_cctv_ch    integer;
begin
  -- 직원 이름 / CCTV 채널 미리 조회
  select name into v_staff_name from public.staff where id = coalesce(new.staff_id, old.staff_id);
  select cctv_channel into v_cctv_ch from public.gateway_zone_map
    where gateway_serial = coalesce(new.gateway_serial, old.gateway_serial) limit 1;

  -- 입장 직후
  if tg_op = 'INSERT' then
    insert into public.presence_cctv_snapshots
      (presence_event_id, staff_id, staff_name, beacon_uuid, zone_id, zone_name,
       gateway_serial, cctv_channel, event_type, tick_seq, dwell_sec, rssi, occurred_at)
    values
      (new.id, new.staff_id, v_staff_name, new.beacon_uuid, new.zone_id, new.zone_name,
       new.gateway_serial, coalesce(new.cctv_channel, v_cctv_ch),
       'entry', 0, 0, new.max_rssi, new.entered_at);
    return new;
  end if;

  -- 퇴장 (exited_at 이 null → not null 로 바뀐 순간)
  if tg_op = 'UPDATE' and old.exited_at is null and new.exited_at is not null then
    insert into public.presence_cctv_snapshots
      (presence_event_id, staff_id, staff_name, beacon_uuid, zone_id, zone_name,
       gateway_serial, cctv_channel, event_type, tick_seq, dwell_sec, rssi, occurred_at)
    values
      (new.id, new.staff_id, v_staff_name, new.beacon_uuid, new.zone_id, new.zone_name,
       new.gateway_serial, coalesce(new.cctv_channel, v_cctv_ch),
       'exit',
       coalesce((select max(tick_seq)+1 from public.presence_cctv_snapshots
                  where presence_event_id = new.id), 1),
       extract(epoch from (new.exited_at - new.entered_at))::int,
       new.max_rssi, new.exited_at);
    return new;
  end if;

  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_queue_cctv_snapshot on public.presence_events;
create trigger trg_queue_cctv_snapshot
  after insert or update of exited_at on public.presence_events
  for each row execute function public.queue_cctv_snapshot_on_presence();

-- ───────────────────────────────────────────────
-- 진단 뷰 — 현재 활성 presence 별 마지막 스냅샷 + 진행상황
-- ───────────────────────────────────────────────
create or replace view public.v_active_cctv_tracking as
select
  pe.id            as presence_event_id,
  pe.staff_id,
  s.name           as staff_name,
  pe.beacon_uuid,
  pe.zone_id,
  pe.zone_name,
  pe.gateway_serial,
  pe.cctv_channel,
  pe.entered_at,
  extract(epoch from (now() - pe.entered_at))::int as dwell_sec_now,
  (select count(*) from public.presence_cctv_snapshots
    where presence_event_id = pe.id and event_type = 'tick_30s') as tick_count,
  (select count(*) from public.presence_cctv_snapshots
    where presence_event_id = pe.id and event_type = 'behavior_change') as change_count,
  (select ai_summary from public.presence_cctv_snapshots
    where presence_event_id = pe.id order by occurred_at desc limit 1) as last_summary,
  (select occurred_at from public.presence_cctv_snapshots
    where presence_event_id = pe.id order by occurred_at desc limit 1) as last_at
from public.presence_events pe
left join public.staff s on s.id = pe.staff_id
where pe.exited_at is null
order by pe.entered_at desc;

comment on table public.presence_cctv_snapshots is
  '비콘 감지 → CCTV 자동 캡쳐 + AI 행동 분석 로그 (입장/30s주기/행동변화/퇴장)';
comment on view  public.v_active_cctv_tracking is
  '활성 presence_events 별 CCTV 추적 진행 상황 (UI 메인 카드용)';
