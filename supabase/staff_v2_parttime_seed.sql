-- ════════════════════════════════════════════════════════════
-- 잠사박물관 직원 관리 v2 — 알바(part-time) 지원 + 신규 직원 추가
-- 적용일: 2026-05-21
-- ════════════════════════════════════════════════════════════
-- 사용법:
--   1. Supabase SQL Editor 열기:
--      https://supabase.com/dashboard/project/ewxquecxsxsfhyzfaaci/sql/new
--   2. 이 파일 전체 복사 → 붙여넣기 → Run
-- ════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────
-- 1) staff 테이블에 알바 관련 컬럼 추가
-- ──────────────────────────────────────────────────────────
ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS is_part_time  boolean      DEFAULT false,
  ADD COLUMN IF NOT EXISTS hired_at      date,         -- 입사일/시작일
  ADD COLUMN IF NOT EXISTS contract_end  date,         -- 알바 종료일 (영구 직원은 null)
  ADD COLUMN IF NOT EXISTS active        boolean      DEFAULT true,
  ADD COLUMN IF NOT EXISTS memo          text,
  ADD COLUMN IF NOT EXISTS created_at    timestamptz  DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz  DEFAULT now();

-- updated_at 자동 갱신 트리거 (이미 있으면 건너뜀)
CREATE OR REPLACE FUNCTION public._staff_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS staff_set_updated_at ON public.staff;
CREATE TRIGGER staff_set_updated_at
  BEFORE UPDATE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public._staff_set_updated_at();


-- ──────────────────────────────────────────────────────────
-- 2) 신규 직원 추가 (김효진 · 윤승수 · 윤찬미)
--    부서: 관리부 (dept_id = 1) — 필요 시 수정
-- ──────────────────────────────────────────────────────────
INSERT INTO public.staff (name, dept_id, phone, is_part_time, active)
VALUES
  ('김효진', 1, NULL, false, true),
  ('윤승수', 1, NULL, false, true),
  ('윤찬미', 1, NULL, false, true)
ON CONFLICT (name) DO UPDATE
  SET dept_id      = EXCLUDED.dept_id,
      is_part_time = EXCLUDED.is_part_time,
      active       = EXCLUDED.active;


-- ──────────────────────────────────────────────────────────
-- 3) RLS 정책 — anon은 read만, service-role은 모든 작업
-- ──────────────────────────────────────────────────────────
-- staff 테이블에 RLS 활성화 (이미 활성화돼있어도 안전)
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;

-- 기존 정책 정리 후 재생성
DROP POLICY IF EXISTS staff_anon_read  ON public.staff;
DROP POLICY IF EXISTS staff_svc_all    ON public.staff;

-- anon 키로는 active=true 인 직원만 조회 가능
CREATE POLICY staff_anon_read ON public.staff
  FOR SELECT TO anon
  USING (active = true);

-- service_role은 모든 작업 가능 (서버사이드 API에서 사용)
CREATE POLICY staff_svc_all ON public.staff
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);


-- ──────────────────────────────────────────────────────────
-- 4) 결과 확인
-- ──────────────────────────────────────────────────────────
SELECT
  s.id,
  s.name           AS 이름,
  d.name           AS 부서,
  CASE WHEN s.is_part_time THEN '알바' ELSE '정직원' END AS 구분,
  s.active         AS 활성,
  s.phone          AS 연락처,
  s.contract_end   AS 종료일,
  s.created_at     AS 등록일
FROM public.staff s
LEFT JOIN public.beacon_dept d ON d.id = s.dept_id
WHERE s.active = true
ORDER BY s.is_part_time, d.id, s.name;


-- ──────────────────────────────────────────────────────────
-- 5) 알바 자동 만료 처리 함수 (선택 — 매일 자정 cron으로 호출)
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_expire_part_time_staff() RETURNS void AS $$
BEGIN
  UPDATE public.staff
    SET active = false, updated_at = now()
  WHERE is_part_time = true
    AND contract_end IS NOT NULL
    AND contract_end < CURRENT_DATE
    AND active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 매일 자정 실행하려면 Supabase Cron(pg_cron) 또는 외부 cron으로:
--   SELECT public.auto_expire_part_time_staff();
