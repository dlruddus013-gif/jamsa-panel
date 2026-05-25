-- ============================================================
-- 단체예약 SMS · 설문 · 경품 확장 스키마
-- 기존 reservation_schema.sql 적용 후 실행 (res_facilities/bookings 참조)
-- ============================================================

-- ─── 13. SMS 메시지 템플릿 ───
CREATE TABLE IF NOT EXISTS res_sms_templates (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  code TEXT NOT NULL,              -- 'booking_confirm', 'd14_reminder', 'd1_arrival_confirm', 'chat_notify', 'survey_invite' 등
  name TEXT NOT NULL,
  message_type TEXT DEFAULT 'SMS', -- SMS / LMS / AT (알림톡)
  subject TEXT,                    -- LMS 제목
  template TEXT NOT NULL,          -- 본문 ({{group_name}}, {{date}}, {{arrival}} 등 변수)
  kakao_template_code TEXT,        -- 알림톡 사전등록 템플릿 코드
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility_code, code)
);

-- ─── 14. SMS 발송 로그 ───
CREATE TABLE IF NOT EXISTS res_sms_logs (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  booking_id BIGINT REFERENCES res_bookings(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,              -- manual / booking_confirm / d14_reminder / d1_arrival_confirm /
                                   --   chat_notify / survey_invite / coupon_issue / etc
  recipient TEXT NOT NULL,         -- 010-xxxx-xxxx
  message_type TEXT DEFAULT 'SMS',
  content TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL,            -- sent / failed / pending / delivered
  message_key TEXT,                -- 뿌리오 응답 식별자 (delivery report 조회용)
  error_code TEXT,
  error_message TEXT,
  elapsed_ms INTEGER,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sms_logs_booking ON res_sms_logs(booking_id);
CREATE INDEX IF NOT EXISTS idx_sms_logs_recent ON res_sms_logs(facility_code, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_logs_kind ON res_sms_logs(facility_code, kind, sent_at DESC);

-- ─── 15. SMS 발송 큐 (스케줄러용) ───
CREATE TABLE IF NOT EXISTS res_sms_queue (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  booking_id BIGINT REFERENCES res_bookings(id) ON DELETE CASCADE,
  template_code TEXT NOT NULL,
  recipient TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  variables JSONB DEFAULT '{}',    -- 템플릿 치환 변수
  status TEXT DEFAULT 'pending',   -- pending / sent / failed / cancelled
  attempt_count INTEGER DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(booking_id, template_code)  -- 같은 예약에 같은 종류 알림 중복 방지
);
CREATE INDEX IF NOT EXISTS idx_sms_queue_due ON res_sms_queue(scheduled_at) WHERE status = 'pending';

-- ─── 16. 만족도 설문 ───
CREATE TABLE IF NOT EXISTS res_surveys (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  booking_id BIGINT REFERENCES res_bookings(id) ON DELETE CASCADE,
  invite_token TEXT UNIQUE NOT NULL,  -- URL 안전 토큰 (응답 페이지 인증용)
  -- 발송
  invite_sent_at TIMESTAMPTZ,
  invite_phone TEXT,
  -- 응답
  responded_at TIMESTAMPTZ,
  rating_overall INTEGER CHECK (rating_overall BETWEEN 1 AND 5),
  rating_program INTEGER CHECK (rating_program BETWEEN 1 AND 5),
  rating_staff INTEGER CHECK (rating_staff BETWEEN 1 AND 5),
  rating_facility INTEGER CHECK (rating_facility BETWEEN 1 AND 5),
  nps INTEGER CHECK (nps BETWEEN 0 AND 10),  -- 추천 의향
  comments TEXT,
  improvement_suggestions TEXT,
  would_revisit BOOLEAN,
  -- 경품 응모
  coupon_issued_id BIGINT,
  agreed_to_marketing BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_surveys_booking ON res_surveys(booking_id);

-- ─── 17. 경품 입장권 (만족도 설문 완료자 대상) ───
CREATE TABLE IF NOT EXISTS res_coupons (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  -- 발급
  code TEXT UNIQUE NOT NULL,         -- 'JP-2026-A1B2C3D4' 형식
  qr_payload TEXT NOT NULL,          -- QR 코드 본문 (URL 또는 JWT)
  coupon_type TEXT DEFAULT 'free_admission',
  description TEXT,
  -- 대상
  booking_id BIGINT REFERENCES res_bookings(id) ON DELETE SET NULL,
  survey_id BIGINT REFERENCES res_surveys(id) ON DELETE SET NULL,
  recipient_phone TEXT,
  recipient_name TEXT,
  -- 유효성
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  -- 사용
  used BOOLEAN DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  used_by TEXT,
  -- 메타
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON res_coupons(code);
CREATE INDEX IF NOT EXISTS idx_coupons_phone ON res_coupons(recipient_phone);

-- ─── 18. 당일 운영 체크 (출발/도착/퇴장 시간 확인) ───
CREATE TABLE IF NOT EXISTS res_day_checkins (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  booking_id BIGINT NOT NULL REFERENCES res_bookings(id) ON DELETE CASCADE,
  check_type TEXT NOT NULL,        -- 'departure_check' (전날 출발시간 재확인) /
                                   --   'arrival_estimate' (도착 10분전 자동 알림) /
                                   --   'exit_check' (전날 퇴장시간 재확인)
  -- 예정
  scheduled_time TIME,             -- 예약 시 기록된 시간
  asked_at TIMESTAMPTZ DEFAULT NOW(),  -- 확인 요청 발송한 시각
  asked_via TEXT DEFAULT 'sms',
  -- 응답
  responded_at TIMESTAMPTZ,
  responded_time TIME,             -- 실제 응답한 시간
  notes TEXT,
  -- 실제 발생
  actual_time TIME,
  actual_at TIMESTAMPTZ,
  UNIQUE(booking_id, check_type)
);

-- ─── 시드: 기본 SMS 템플릿 5개 ───
INSERT INTO res_sms_templates (facility_code, code, name, message_type, template) VALUES
  ('jp', 'booking_confirm', '예약 접수 안내', 'SMS',
   '[잠사박물관] {{group_name}}님 단체 예약이 접수되었습니다.
일시: {{date}} {{arrival}}~{{departure}}
인원: 학생 {{students}}명/인솔 {{teachers}}명
문의: 043-836-7000'),
  ('jp', 'd14_reminder', 'D-14 일정 공유', 'SMS',
   '[잠사박물관] {{group_name}}님 방문이 2주 앞으로 다가왔습니다.
📅 {{date}} {{arrival}}~{{departure}}
🚌 셔틀 정보: jamsa.kr/guide/{{token}}
변경/취소: 043-836-7000'),
  ('jp', 'd1_arrival_confirm', 'D-1 도착시간 재확인', 'SMS',
   '[잠사박물관] 내일 방문 안내입니다.
예정: {{arrival}} 도착 / {{departure}} 출발
출발지·예상 도착시간 회신 부탁드립니다 (정문 입장 지원).
회신: jamsa.kr/checkin/{{token}}'),
  ('jp', 'chat_notify', '신규 채팅 알림', 'SMS',
   '[잠사박물관] {{sender}}님 새 채팅: "{{preview}}"
답변: jamsa-panel.vercel.app/#reservation'),
  ('jp', 'survey_invite', '만족도 설문 + 경품', 'SMS',
   '[잠사박물관] {{group_name}}님 방문해주셔서 감사합니다.
2분 설문에 응답하시면 무료 입장권 1매 자동 발급됩니다 🎁
설문: jamsa.kr/survey/{{token}}')
ON CONFLICT (facility_code, code) DO NOTHING;

-- ─── RLS ───
ALTER TABLE res_sms_templates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_sms_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_sms_queue      ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_surveys        ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_coupons        ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_day_checkins   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'res_sms_templates','res_sms_logs','res_sms_queue',
    'res_surveys','res_coupons','res_day_checkins'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS authenticated_read_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY authenticated_read_%I ON %I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS admin_full_%I ON %I', t, t);
    EXECUTE format('CREATE POLICY admin_full_%I ON %I FOR ALL TO authenticated USING ((auth.jwt() -> ''user_metadata'' ->> ''role'') = ''admin'')', t, t);
  END LOOP;
END $$;

-- 설문 응답은 anon 도 토큰으로 조회/수정 가능 (고객 본인이 응답)
DROP POLICY IF EXISTS anon_survey_by_token ON res_surveys;
CREATE POLICY anon_survey_by_token ON res_surveys
  FOR SELECT TO anon
  USING (invite_token IS NOT NULL);
DROP POLICY IF EXISTS anon_survey_update_by_token ON res_surveys;
CREATE POLICY anon_survey_update_by_token ON res_surveys
  FOR UPDATE TO anon
  USING (invite_token IS NOT NULL AND responded_at IS NULL);

-- ─── Realtime ───
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE res_sms_logs;
  ALTER PUBLICATION supabase_realtime ADD TABLE res_surveys;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  RAISE NOTICE '✅ SMS · 설문 · 경품 스키마 적용 완료';
  RAISE NOTICE '   테이블 6개: sms_templates, sms_logs, sms_queue, surveys, coupons, day_checkins';
  RAISE NOTICE '   시드: SMS 템플릿 5개 (booking_confirm/d14_reminder/d1_arrival_confirm/chat_notify/survey_invite)';
END $$;
