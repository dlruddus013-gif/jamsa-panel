-- ════════════════════════════════════════════════════════════
-- 한국잠사박물관 통합관리 시스템 — Supabase 스키마
-- ════════════════════════════════════════════════════════════
-- 실행 방법:
--   1. Supabase Dashboard → SQL Editor → New Query
--   2. 이 파일 전체 복사 → 붙여넣기 → Run
-- ════════════════════════════════════════════════════════════

-- 확장
create extension if not exists "pgcrypto";

-- ═══════════════════════════════════════════
-- 1. 조직 (잠사박물관 = 'jamsa', 향후 다중 시설 가능)
-- ═══════════════════════════════════════════
create table if not exists public.organizations (
  id text primary key,
  name text not null,
  created_at timestamptz default now()
);

insert into public.organizations (id, name)
values ('jamsa', '한국잠사플레이팜')
on conflict (id) do nothing;

-- ═══════════════════════════════════════════
-- 2. 멤버십 (사용자 ↔ 조직, 역할)
-- ═══════════════════════════════════════════
create table if not exists public.memberships (
  user_id uuid references auth.users(id) on delete cascade,
  org_id text references public.organizations(id) on delete cascade,
  role text not null default 'viewer' check (role in ('admin','manager','inspector','viewer')),
  dept text,
  display_name text,
  created_at timestamptz default now(),
  primary key (user_id, org_id)
);

-- ═══════════════════════════════════════════
-- 3. KV Store — React useLocalStorage 백엔드
-- ═══════════════════════════════════════════
create table if not exists public.kv_store (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz default now(),
  unique (org_id, key)
);

-- 인덱스
create index if not exists kv_store_org_key_idx on public.kv_store (org_id, key);
create index if not exists kv_store_value_gin_idx on public.kv_store using gin (value jsonb_path_ops);
create index if not exists kv_store_updated_idx on public.kv_store (updated_at desc);

-- updated_at 자동 갱신
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists kv_store_updated_at on public.kv_store;
create trigger kv_store_updated_at
  before update on public.kv_store
  for each row execute function public.set_updated_at();

-- ═══════════════════════════════════════════
-- 4. 감사 로그 (보안: 누가 무엇을 변경했나)
-- ═══════════════════════════════════════════
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  action text not null,        -- 'KV_PUT', 'KV_DELETE', 'LOGIN', etc.
  resource text,                -- e.g. 'jamsa_inv_prods'
  payload jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz default now()
);

create index if not exists audit_logs_org_created_idx on public.audit_logs (org_id, created_at desc);
create index if not exists audit_logs_user_idx on public.audit_logs (user_id);

-- ═══════════════════════════════════════════
-- 5. RLS (Row Level Security)
-- ═══════════════════════════════════════════
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.kv_store enable row level security;
alter table public.audit_logs enable row level security;

-- 조직: 멤버만 조회
drop policy if exists "members read org" on public.organizations;
create policy "members read org" on public.organizations
  for select using (
    exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.org_id = organizations.id)
  );

-- 멤버십: 본인 + 같은 조직
drop policy if exists "members read membership" on public.memberships;
create policy "members read membership" on public.memberships
  for select using (
    user_id = auth.uid() or
    exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.org_id = memberships.org_id)
  );

-- KV: 같은 조직 멤버만 읽기/쓰기
drop policy if exists "org members read kv" on public.kv_store;
create policy "org members read kv" on public.kv_store
  for select using (
    exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.org_id = kv_store.org_id)
  );

drop policy if exists "org members write kv" on public.kv_store;
create policy "org members write kv" on public.kv_store
  for insert with check (
    exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.org_id = kv_store.org_id and m.role in ('admin','manager','inspector'))
  );

drop policy if exists "org members update kv" on public.kv_store;
create policy "org members update kv" on public.kv_store
  for update using (
    exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.org_id = kv_store.org_id and m.role in ('admin','manager','inspector'))
  );

drop policy if exists "admin delete kv" on public.kv_store;
create policy "admin delete kv" on public.kv_store
  for delete using (
    exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.org_id = kv_store.org_id and m.role in ('admin','manager'))
  );

-- 감사로그: 본인 또는 admin만 조회 (쓰기는 service role만)
drop policy if exists "members read audit" on public.audit_logs;
create policy "members read audit" on public.audit_logs
  for select using (
    user_id = auth.uid() or
    exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.org_id = audit_logs.org_id and m.role = 'admin')
  );

-- ═══════════════════════════════════════════
-- 6. 검색 함수 (jsonb 깊은 검색)
-- ═══════════════════════════════════════════
create or replace function public.search_kv(
  p_org_id text,
  p_query text,
  p_limit int default 50
)
returns table (
  collection text,
  item_index int,
  item jsonb,
  preview text
)
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_member boolean;
begin
  -- 인증 확인
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;

  -- 조직 멤버 확인
  select exists(
    select 1 from public.memberships
    where user_id = v_user_id and org_id = p_org_id
  ) into v_member;

  if not v_member then
    raise exception 'not a member of org %', p_org_id;
  end if;

  -- 검색
  return query
  with rows as (
    select
      kv.key as col,
      idx.ordinality::int - 1 as i,
      idx.item as it
    from public.kv_store kv,
      lateral jsonb_array_elements(case
        when jsonb_typeof(kv.value) = 'array' then kv.value
        else jsonb_build_array(kv.value)
      end) with ordinality as idx(item, ordinality)
    where kv.org_id = p_org_id
      and kv.value::text ilike '%' || p_query || '%'
  )
  select
    r.col as collection,
    r.i as item_index,
    r.it as item,
    coalesce(
      r.it->>'name',
      r.it->>'title',
      r.it->>'label',
      r.it->>'product',
      r.it->>'desc',
      r.it->>'memo',
      r.it::text
    )::text as preview
  from rows r
  where r.it::text ilike '%' || p_query || '%'
  order by collection, item_index
  limit p_limit;
end;
$$;

grant execute on function public.search_kv to authenticated;

-- ═══════════════════════════════════════════
-- 7. 통계 함수
-- ═══════════════════════════════════════════
create or replace function public.kv_stats(p_org_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_member boolean;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;

  select exists(
    select 1 from public.memberships
    where user_id = v_user_id and org_id = p_org_id
  ) into v_member;

  if not v_member then
    raise exception 'not a member';
  end if;

  select jsonb_build_object(
    'collections', count(*),
    'total_size', coalesce(sum(pg_column_size(value)), 0),
    'last_updated', max(updated_at)
  ) into v_result
  from public.kv_store
  where org_id = p_org_id;

  return v_result;
end;
$$;

grant execute on function public.kv_stats to authenticated;

-- ═══════════════════════════════════════════
-- 8. 사용자 첫 가입 시 자동 멤버십
-- ═══════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.memberships (user_id, org_id, role, display_name)
  values (
    new.id,
    'jamsa',
    case when (select count(*) from public.memberships where org_id = 'jamsa') = 0
         then 'admin' else 'viewer' end,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
  )
  on conflict do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ═══════════════════════════════════════════
-- 완료 메시지
-- ═══════════════════════════════════════════
do $$
begin
  raise notice '✅ 잠사박물관 Supabase 스키마 설치 완료';
  raise notice '  - 조직: organizations';
  raise notice '  - 멤버: memberships (자동 생성, 첫 사용자=admin)';
  raise notice '  - 데이터: kv_store (org_id + key 유니크)';
  raise notice '  - 감사로그: audit_logs';
  raise notice '  - RLS: 모든 테이블 활성화';
  raise notice '  - 검색: search_kv() 함수';
end $$;
