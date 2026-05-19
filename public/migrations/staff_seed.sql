-- ============================================================
-- 잠사박물관 직원 명단 일괄 등록 SQL
-- 적용일: 2026-05-20
-- ============================================================
-- 사용법:
--   1. 아래 VALUES 줄에 실제 직원 이름·부서·비콘ID·비자 정보 입력
--   2. Supabase SQL Editor에 붙여넣기 → Run
--   3. 결과창에 등록된 직원 목록 표시됨
-- ============================================================
-- 주의:
--   - 같은 이름이 이미 있으면 UPSERT 처리되어 정보만 갱신됨
--   - beacon_id 가 없으면 NULL 로 두면 됩니다
--   - 외국인 직원은 visa_type / visa_expiry 필수
-- ============================================================


-- ───────────────────────────────────────────────────────────
-- 1) 부서 마스터 확인 (이미 3건 시드됨)
-- ───────────────────────────────────────────────────────────
SELECT id, name FROM public.beacon_dept ORDER BY id;
-- 출력 예시:
--   1 | 관리부
--   2 | 시설부
--   3 | 외국인


-- ───────────────────────────────────────────────────────────
-- 2) 직원 일괄 등록 (예시 데이터 — 실제로 교체하세요)
-- ───────────────────────────────────────────────────────────
INSERT INTO public.staff (name, dept_id, beacon_id, phone, visa_type, visa_expiry)
VALUES
  -- 관리부 (dept_id = 1)
  ('이경연',      1, NULL,        '010-0000-0000', NULL, NULL),
  ('홍길동',      1, 'BCN-A001',  '010-1111-2222', NULL, NULL),

  -- 시설부 (dept_id = 2)
  ('김철수',      2, 'BCN-B001',  '010-2222-3333', NULL, NULL),
  ('박영희',      2, 'BCN-B002',  '010-3333-4444', NULL, NULL),

  -- 외국인 (dept_id = 3) — visa_type / visa_expiry 필수
  ('Nguyen Van A', 3, 'BCN-C001',  '010-4444-5555', 'E-9',  '2027-03-31'),
  ('Sok Dara',     3, 'BCN-C002',  '010-5555-6666', 'E-9',  '2026-12-15'),
  ('Maria Santos', 3, 'BCN-C003',  '010-6666-7777', 'H-2',  '2028-08-20')

ON CONFLICT (name) DO UPDATE
  SET dept_id     = EXCLUDED.dept_id,
      beacon_id   = EXCLUDED.beacon_id,
      phone       = EXCLUDED.phone,
      visa_type   = EXCLUDED.visa_type,
      visa_expiry = EXCLUDED.visa_expiry;


-- ───────────────────────────────────────────────────────────
-- 3) 등록 결과 확인
-- ───────────────────────────────────────────────────────────
SELECT
  s.id,
  s.name           AS 이름,
  d.name           AS 부서,
  s.beacon_id      AS 비콘ID,
  s.phone          AS 연락처,
  s.visa_type      AS 비자종류,
  s.visa_expiry    AS 비자만료일
FROM public.staff s
LEFT JOIN public.beacon_dept d ON d.id = s.dept_id
ORDER BY d.id, s.id;


-- ───────────────────────────────────────────────────────────
-- 4) 외국인 비자 만료 임박자 확인 (90일 이내)
-- ───────────────────────────────────────────────────────────
SELECT * FROM public.v_foreign_workers
WHERE visa_expiry <= CURRENT_DATE + INTERVAL '90 days'
ORDER BY visa_expiry ASC;


-- ============================================================
-- 끝 — ON CONFLICT(name) 덕분에 같은 SQL 여러 번 돌려도 안전합니다
-- ============================================================
