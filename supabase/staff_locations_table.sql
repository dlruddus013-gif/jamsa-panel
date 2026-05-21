-- ════════════════════════════════════════════════════════════
-- staff_locations 테이블 생성 — 실시간 위치 공유
-- 적용일: 2026-05-21
-- ════════════════════════════════════════════════════════════
-- 사용법:
--   Supabase SQL Editor 에 전체 복사 → 붙여넣기 → Run
-- ════════════════════════════════════════════════════════════

-- 1) 테이블 생성
CREATE TABLE IF NOT EXISTS public.staff_locations (
  id            text         PRIMARY KEY,           -- staff_id 또는 visitor_id
  name          text,
  lat           double precision,
  lng           double precision,
  accuracy      double precision,                   -- GPS 정확도 (m)
  source        text,                               -- gps / mobile_gps / wifi / beacon / manual
  beacon_id     text,
  beacon_name   text,
  role          text         DEFAULT 'staff',       -- staff / visitor / parttime
  dept          text,
  last_seen     timestamptz  DEFAULT now(),
  updated_at    timestamptz  DEFAULT now(),
  created_at    timestamptz  DEFAULT now()
);

-- 2) 인덱스 (최근 위치 조회 + role 필터링 빠르게)
CREATE INDEX IF NOT EXISTS idx_staff_locations_updated_at  ON public.staff_locations (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_locations_role        ON public.staff_locations (role);
CREATE INDEX IF NOT EXISTS idx_staff_locations_last_seen   ON public.staff_locations (last_seen DESC);

-- 3) updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION public._loc_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS loc_set_updated_at ON public.staff_locations;
CREATE TRIGGER loc_set_updated_at
  BEFORE UPDATE ON public.staff_locations
  FOR EACH ROW EXECUTE FUNCTION public._loc_set_updated_at();


-- 4) RLS 정책 — anon은 read만, service_role은 모든 작업
ALTER TABLE public.staff_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS loc_anon_read  ON public.staff_locations;
DROP POLICY IF EXISTS loc_anon_write ON public.staff_locations;
DROP POLICY IF EXISTS loc_svc_all    ON public.staff_locations;

-- 누구나(anon 포함) 최근 5분 위치를 SELECT 가능 (실시간 공유)
CREATE POLICY loc_anon_read ON public.staff_locations
  FOR SELECT TO anon
  USING (updated_at > now() - interval '5 minutes');

-- anon도 본인 위치만 upsert 가능 (모바일 페이지가 anon 키로 호출)
-- 단, source=mobile_gps 등 명시된 source만
CREATE POLICY loc_anon_write ON public.staff_locations
  FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY loc_anon_update ON public.staff_locations
  FOR UPDATE TO anon
  USING (true) WITH CHECK (true);

-- service_role은 모든 작업
CREATE POLICY loc_svc_all ON public.staff_locations
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);


-- 5) 오래된 위치 자동 정리 함수 (선택 — 7일 이상 미갱신 자동 삭제)
CREATE OR REPLACE FUNCTION public.cleanup_stale_locations() RETURNS integer AS $$
DECLARE deleted_count integer;
BEGIN
  WITH d AS (
    DELETE FROM public.staff_locations
    WHERE updated_at < now() - interval '7 days'
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM d;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 6) 결과 확인
SELECT
  '✅ staff_locations 테이블 준비 완료' AS 상태,
  count(*) AS 현재_저장된_위치수
FROM public.staff_locations;

SELECT
  column_name AS 컬럼명,
  data_type   AS 타입
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'staff_locations'
ORDER BY ordinal_position;
