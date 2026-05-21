-- ════════════════════════════════════════════════════════════
-- 대리 출석 방지 — 디바이스 본인 인증 마이그레이션
-- 적용일: 2026-05-21
-- ════════════════════════════════════════════════════════════
-- 사용법:
--   Supabase SQL Editor에 전체 복사 → Run
-- ════════════════════════════════════════════════════════════

-- 1) staff 테이블에 본인 등록 디바이스 정보
ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS primary_device_id    text,        -- 첫 출근 시 등록되는 디바이스 UUID
  ADD COLUMN IF NOT EXISTS primary_device_at    timestamptz, -- 등록 시각
  ADD COLUMN IF NOT EXISTS primary_device_name  text,        -- "Galaxy S23 · Samsung Internet" 등
  ADD COLUMN IF NOT EXISTS primary_device_ip    text,        -- 등록 시 IP
  ADD COLUMN IF NOT EXISTS device_locked        boolean DEFAULT true; -- false면 다른 기기도 허용

-- 2) attendance 테이블에 출퇴근 시 디바이스 정보 기록
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS device_id     text,
  ADD COLUMN IF NOT EXISTS device_ip     text,
  ADD COLUMN IF NOT EXISTS device_name   text,
  ADD COLUMN IF NOT EXISTS device_match  text;  -- 'ok' / 'new_register' / 'mismatch_blocked' / 'mismatch_allowed'

CREATE INDEX IF NOT EXISTS idx_attendance_device_id ON public.attendance (device_id);

-- 3) 의심 출근 시도 로그 (대리 출석 시도)
CREATE TABLE IF NOT EXISTS public.attendance_security_log (
  id           bigserial    PRIMARY KEY,
  staff_id     int          REFERENCES public.staff(id) ON DELETE SET NULL,
  staff_name   text,
  event_type   text,        -- 'mismatch_attempt' / 'device_register' / 'device_reset'
  attempted_device_id   text,
  registered_device_id  text,
  ip           text,
  user_agent   text,
  details      jsonb,
  created_at   timestamptz  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_log_staff   ON public.attendance_security_log (staff_id);
CREATE INDEX IF NOT EXISTS idx_security_log_created ON public.attendance_security_log (created_at DESC);

-- 4) RLS — service_role만 보안 로그 접근, anon은 insert만
ALTER TABLE public.attendance_security_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sec_log_anon_insert ON public.attendance_security_log;
DROP POLICY IF EXISTS sec_log_svc_all     ON public.attendance_security_log;

-- 의심 시도는 anon도 기록 가능 (자기 시도 기록)
CREATE POLICY sec_log_anon_insert ON public.attendance_security_log
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY sec_log_svc_all ON public.attendance_security_log
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);


-- 5) 본인 디바이스 등록/검증 RPC (anon이 호출 가능)
-- 반환: 'ok' (정상), 'registered' (첫 등록), 'mismatch' (다른 기기 - 차단)
CREATE OR REPLACE FUNCTION public.verify_or_register_device(
  p_staff_id    int,
  p_device_id   text,
  p_device_name text DEFAULT NULL,
  p_ip          text DEFAULT NULL
) RETURNS json AS $$
DECLARE
  v_primary_id text;
  v_locked     boolean;
  v_name       text;
BEGIN
  -- 직원 정보 조회
  SELECT primary_device_id, device_locked, name
    INTO v_primary_id, v_locked, v_name
  FROM public.staff
  WHERE id = p_staff_id AND active = true;

  IF v_name IS NULL THEN
    RETURN json_build_object('status', 'staff_not_found');
  END IF;

  -- 첫 등록
  IF v_primary_id IS NULL OR v_primary_id = '' THEN
    UPDATE public.staff
      SET primary_device_id   = p_device_id,
          primary_device_at   = now(),
          primary_device_name = p_device_name,
          primary_device_ip   = p_ip,
          updated_at          = now()
    WHERE id = p_staff_id;

    INSERT INTO public.attendance_security_log
      (staff_id, staff_name, event_type, attempted_device_id, registered_device_id, ip, details)
    VALUES (p_staff_id, v_name, 'device_register', p_device_id, p_device_id, p_ip,
            json_build_object('device_name', p_device_name));

    RETURN json_build_object('status', 'registered', 'device_id', p_device_id);
  END IF;

  -- 매칭
  IF v_primary_id = p_device_id THEN
    RETURN json_build_object('status', 'ok');
  END IF;

  -- 잠금 해제 상태 → 통과 (관리자가 다른 기기 허용)
  IF v_locked = false THEN
    RETURN json_build_object('status', 'ok_unlocked');
  END IF;

  -- 의심 시도 기록
  INSERT INTO public.attendance_security_log
    (staff_id, staff_name, event_type, attempted_device_id, registered_device_id, ip, details)
  VALUES (p_staff_id, v_name, 'mismatch_attempt', p_device_id, v_primary_id, p_ip,
          json_build_object('device_name', p_device_name));

  RETURN json_build_object(
    'status', 'mismatch',
    'registered_device', v_primary_id,
    'attempted_device', p_device_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- anon이 RPC 호출 가능하도록 권한 부여
GRANT EXECUTE ON FUNCTION public.verify_or_register_device(int, text, text, text) TO anon;


-- 6) 결과 확인
SELECT '✅ 디바이스 본인 인증 컬럼 + RPC + 보안 로그 준비 완료' AS 상태;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'staff' AND column_name LIKE 'primary_device%' OR column_name = 'device_locked'
ORDER BY ordinal_position;
