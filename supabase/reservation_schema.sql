-- ============================================================
-- 🎫 단체예약관리 (group-reservation) Supabase 스키마
-- ─────────────────────────────────────────────────────────────
-- HTML(jamsa-reservation-v2.6.1)의 localStorage 키 구조를 PG 테이블로 매핑.
-- 시설(facility) → 예약(booking) → 대행사(agency) → 입금(payment) 핵심 흐름.
-- RLS: anon 차단 / authenticated 읽기 / admin role CRUD.
-- 잠사박물관 단일 시설 시드 1건 자동 입력.
-- ============================================================

-- ─── 1. 시설 (FLIST_K = '__fac_list') ───
CREATE TABLE IF NOT EXISTS res_facilities (
  code TEXT PRIMARY KEY,            -- 'jp', 'f1700000001' 등
  name TEXT NOT NULL,               -- '잠사박물관'
  description TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 2. 예약 (FP+'bk') ───
CREATE TABLE IF NOT EXISTS res_bookings (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  -- 기본 정보
  booking_date DATE NOT NULL,       -- 예약 날짜
  group_name TEXT NOT NULL,         -- 단체명 (학교/유치원/회사명)
  category TEXT DEFAULT '미분류',    -- '유치원'/'초등'/'중등'/'고등'/'성인'/'기타'
  -- 시간
  arrival_time TIME DEFAULT '10:00',
  departure_time TIME DEFAULT '14:00',
  -- 인원
  students INTEGER DEFAULT 0,
  teachers INTEGER DEFAULT 0,
  -- 연락처
  phone TEXT,
  email TEXT,
  leader_name TEXT,                 -- 인솔자
  -- 상태
  status TEXT DEFAULT '대기',        -- 대기/확정/취소/완료
  channel TEXT,                     -- 카카오톡/네이버/전화/홈피
  -- 코스/메모
  course TEXT,
  memo TEXT,
  -- 대행사
  agency_code TEXT REFERENCES res_agencies(code) ON DELETE SET NULL,
  -- 결제
  total_amount INTEGER DEFAULT 0,   -- 예상 금액 (원)
  paid_amount INTEGER DEFAULT 0,    -- 실제 입금 (원)
  payment_status TEXT DEFAULT '미입금', -- 미입금/부분입금/완납/환불
  -- 감사
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON res_bookings(facility_code, booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON res_bookings(facility_code, status);
CREATE INDEX IF NOT EXISTS idx_bookings_agency ON res_bookings(agency_code);

-- ─── 3. 대행사 (FP+'agencies') ───
CREATE TABLE IF NOT EXISTS res_agencies (
  code TEXT PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  name TEXT NOT NULL,
  manager_name TEXT,                -- 담당자
  phone TEXT,
  email TEXT,
  -- 사업자 정보 (FP+'agbiz_'+code)
  biz_number TEXT,                  -- 사업자등록번호
  biz_name TEXT,                    -- 상호
  biz_address TEXT,
  biz_ceo TEXT,                     -- 대표자명
  -- 계좌 (FP+'agbank_'+code)
  bank_name TEXT,
  bank_account TEXT,
  bank_holder TEXT,
  -- 정산 (FP+'agsettle_'+code)
  commission_rate NUMERIC(5,2) DEFAULT 10.00,  -- 수수료율 %
  settlement_cycle TEXT DEFAULT '월말',          -- 정산주기
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT
);

-- ─── 4. 코스 정보 (FP+'courseInfo') ───
CREATE TABLE IF NOT EXISTS res_courses (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  code TEXT NOT NULL,               -- 코스 코드 (시설 내 고유)
  name TEXT NOT NULL,               -- 'A코스 (체험+해설)'
  duration_min INTEGER DEFAULT 120, -- 소요 시간 (분)
  capacity_min INTEGER DEFAULT 10,  -- 최소 인원
  capacity_max INTEGER DEFAULT 100, -- 최대 인원
  price_per_person INTEGER DEFAULT 0,  -- 1인당 가격
  description TEXT,
  active BOOLEAN DEFAULT TRUE,
  UNIQUE(facility_code, code)
);

-- ─── 5. 일자별 수용 한도 (FP+'daylimits') ───
CREATE TABLE IF NOT EXISTS res_day_limits (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  limit_date DATE NOT NULL,
  max_groups INTEGER DEFAULT 10,    -- 그 날 최대 단체 수
  max_people INTEGER DEFAULT 500,   -- 그 날 최대 총인원
  notes TEXT,
  UNIQUE(facility_code, limit_date)
);

-- ─── 6. 스케줄 자동 규칙 (FP+'schrules') ───
CREATE TABLE IF NOT EXISTS res_schedule_rules (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  rule_name TEXT NOT NULL,
  day_of_week INTEGER,              -- 0=일 ~ 6=토, NULL=매일
  open_time TIME DEFAULT '10:00',
  close_time TIME DEFAULT '17:00',
  slot_minutes INTEGER DEFAULT 60,  -- 슬롯 길이
  max_per_slot INTEGER DEFAULT 1,
  active BOOLEAN DEFAULT TRUE
);

-- ─── 7. 입금 내역 (FP+'pvr' = payment voucher received) ───
CREATE TABLE IF NOT EXISTS res_payments (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  booking_id BIGINT REFERENCES res_bookings(id) ON DELETE SET NULL,
  agency_code TEXT REFERENCES res_agencies(code) ON DELETE SET NULL,
  -- 입금 정보
  payment_date DATE NOT NULL,
  amount INTEGER NOT NULL,
  bank_name TEXT,
  depositor_name TEXT,              -- 입금자명
  account_no TEXT,                  -- 입금 계좌
  -- 매칭 상태
  matched BOOLEAN DEFAULT FALSE,    -- 예약과 매칭됐는지
  match_method TEXT,                -- 자동/수동/일괄
  -- 메모
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_date ON res_payments(facility_code, payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_unmatched ON res_payments(facility_code) WHERE matched = FALSE;

-- ─── 8. 정산 (FP+'agsettle_'+code) ───
CREATE TABLE IF NOT EXISTS res_settlements (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  agency_code TEXT NOT NULL REFERENCES res_agencies(code) ON DELETE CASCADE,
  settlement_period TEXT NOT NULL,  -- '2026-05', '2026-Q2' 등
  -- 금액
  gross_amount INTEGER DEFAULT 0,
  commission_amount INTEGER DEFAULT 0,
  net_amount INTEGER DEFAULT 0,
  -- 상태
  status TEXT DEFAULT '대기',        -- 대기/확정/지급완료/보류
  paid_at TIMESTAMPTZ,
  -- 첨부
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agency_code, settlement_period)
);

-- ─── 9. 채팅 (FP+'chats') ───
CREATE TABLE IF NOT EXISTS res_chats (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,          -- 카톡 대화방 ID 또는 내부 thread
  sender TEXT,                      -- 발신자 (이름 또는 ID)
  sender_role TEXT DEFAULT 'customer', -- customer/admin/bot
  message TEXT NOT NULL,
  message_type TEXT DEFAULT 'text', -- text/image/file/system
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  -- 메타
  channel TEXT,                     -- '카카오톡', '네이버톡톡' 등
  raw_payload JSONB,
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chats_thread ON res_chats(facility_code, thread_id, sent_at);

-- ─── 10. 챗봇 FAQ (FP+'chatfaq') ───
CREATE TABLE IF NOT EXISTS res_chat_faq (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT[],                  -- 매칭 키워드
  active BOOLEAN DEFAULT TRUE,
  display_order INTEGER DEFAULT 0,
  hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 11. 활동 로그 (FP+'actlog') ───
CREATE TABLE IF NOT EXISTS res_activity_log (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  action TEXT NOT NULL,             -- 'booking.create', 'payment.add' 등
  entity_type TEXT,                 -- 'booking', 'payment', 'agency'
  entity_id TEXT,
  user_id TEXT,
  user_name TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_actlog_recent ON res_activity_log(facility_code, created_at DESC);

-- ─── 12. 관리자 (FP+'admins') ───
CREATE TABLE IF NOT EXISTS res_admins (
  id BIGSERIAL PRIMARY KEY,
  facility_code TEXT NOT NULL REFERENCES res_facilities(code) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'staff',        -- owner/admin/staff/viewer
  active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(facility_code, email)
);

-- ─── 시드 데이터 ───
INSERT INTO res_facilities (code, name, description) VALUES
  ('jp', '잠사박물관', '한국잠사플레이팜 단체예약 시스템 — 단체관광·교육 프로그램')
ON CONFLICT (code) DO NOTHING;

INSERT INTO res_courses (facility_code, code, name, duration_min, capacity_min, capacity_max, price_per_person, description) VALUES
  ('jp', 'A', '기본 체험 코스', 90, 10, 80, 8000, '누에쉘터 + 잠사식당 견학 (90분)'),
  ('jp', 'B', '풀패키지 (체험+공방)', 180, 10, 60, 15000, '실 만들기·매듭 공방 포함 (180분)'),
  ('jp', 'C', '단체 셔틀 포함', 120, 20, 100, 12000, '왕복 셔틀 + 점심 도시락 포함'),
  ('jp', 'D', '교육과정 연계 (학교 단체)', 120, 30, 150, 7000, '교과서 단원 연계 해설 프로그램')
ON CONFLICT (facility_code, code) DO NOTHING;

INSERT INTO res_chat_faq (facility_code, question, answer, keywords, display_order) VALUES
  ('jp', '운영시간이 어떻게 되나요?', '평일 09:00~17:00, 주말 10:00~18:00 운영합니다. 매주 월요일 휴관.', ARRAY['시간', '영업', '운영', '휴관'], 1),
  ('jp', '단체 예약은 몇 명부터 가능한가요?', '단체는 10명 이상부터 예약 가능합니다. 코스에 따라 최소 인원이 다릅니다.', ARRAY['단체', '최소', '인원', '예약'], 2),
  ('jp', '주차장이 있나요?', '대형 버스 3대, 승용차 50대 무료 주차 가능합니다. 1주차장 만석 시 2주차장으로 안내드립니다.', ARRAY['주차', '버스', '차량'], 3),
  ('jp', '점심은 어떻게 하나요?', '코스 C 선택 시 도시락 포함. 그 외 단체는 잠사식당 사전 예약(별도) 또는 외부 도시락 지참 가능.', ARRAY['점심', '식사', '도시락', '식당'], 4)
ON CONFLICT DO NOTHING;

-- ─── RLS 정책 ───
ALTER TABLE res_facilities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_bookings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_agencies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_courses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_day_limits      ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_schedule_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_payments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_settlements     ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_chats           ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_chat_faq        ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_activity_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE res_admins          ENABLE ROW LEVEL SECURITY;

-- 모든 hr_* 처럼: anon 차단 / authenticated 읽기 / admin 전체
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'res_facilities','res_bookings','res_agencies','res_courses',
    'res_day_limits','res_schedule_rules','res_payments','res_settlements',
    'res_chats','res_chat_faq','res_activity_log','res_admins'
  ] LOOP
    EXECUTE format('CREATE POLICY IF NOT EXISTS authenticated_read_%I ON %I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('CREATE POLICY IF NOT EXISTS admin_full_%I ON %I FOR ALL TO authenticated USING ((auth.jwt() -> ''user_metadata'' ->> ''role'') = ''admin'')', t, t);
  END LOOP;
END $$;

-- 챗봇 FAQ는 anon 도 읽기 가능 (예약 페이지에서 비로그인 고객도 조회)
CREATE POLICY IF NOT EXISTS anon_read_chat_faq ON res_chat_faq FOR SELECT TO anon USING (active = TRUE);

-- ─── Realtime publication ───
DO $$
BEGIN
  PERFORM 1 FROM pg_publication WHERE pubname = 'supabase_realtime';
  IF FOUND THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE res_bookings;
    ALTER PUBLICATION supabase_realtime ADD TABLE res_payments;
    ALTER PUBLICATION supabase_realtime ADD TABLE res_chats;
  END IF;
EXCEPTION WHEN duplicate_object THEN
  -- 이미 추가됨
  NULL;
END $$;

-- ─── updated_at 트리거 ───
CREATE OR REPLACE FUNCTION res_set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS res_bookings_updated ON res_bookings;
CREATE TRIGGER res_bookings_updated BEFORE UPDATE ON res_bookings
  FOR EACH ROW EXECUTE FUNCTION res_set_updated_at();

-- ─── 완료 메시지 ───
DO $$ BEGIN
  RAISE NOTICE '✅ 단체예약관리 스키마 적용 완료';
  RAISE NOTICE '   테이블: 12개 (res_facilities, res_bookings, res_agencies, res_courses, res_day_limits, res_schedule_rules, res_payments, res_settlements, res_chats, res_chat_faq, res_activity_log, res_admins)';
  RAISE NOTICE '   시드: 시설 1건 (잠사박물관) + 코스 4건 + FAQ 4건';
  RAISE NOTICE '   RLS: anon 차단, authenticated 읽기, admin role CRUD';
  RAISE NOTICE '   Realtime: res_bookings, res_payments, res_chats';
END $$;
