-- ════════════════════════════════════════════════════════════════
-- jamsa-panel Part B 풀 시스템 — 자동 알림 + 직원 호출 테이블
-- 실행 위치: Supabase 프로젝트 → SQL Editor → New query
-- 의존성: 없음 (기존 schema.sql과 독립적)
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────
-- 1. 자동 알림 이력 (auto_alerts)
-- ────────────────────────────────────────
-- 트리거 조건:
--   • 과밀: 한 구역 25명 이상 또는 CCTV AI density VERY_HIGH
--   • 위험: CCTV AI score 80+ 또는 분류 DANGER (화재/연기/이상행동)
-- 중복 방지: 같은 zone_id + alert_type 조합은 5분 내 중복 차단
CREATE TABLE IF NOT EXISTS auto_alerts (
  id BIGSERIAL PRIMARY KEY,
  alert_type TEXT NOT NULL,            -- 'crowd' | 'fire' | 'medical' | 'manual' | 'lost'
  zone_id TEXT,
  zone_name TEXT,
  severity TEXT DEFAULT 'WARNING',     -- INFO | WARNING | DANGER
  message TEXT,
  channel_ch INTEGER,
  people_count INTEGER,
  auto_called BOOLEAN DEFAULT FALSE,
  recipients JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON auto_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_zone    ON auto_alerts(zone_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_type    ON auto_alerts(alert_type, created_at);

-- ────────────────────────────────────────
-- 2. 직원 호출 이력 (staff_calls)
-- ────────────────────────────────────────
-- 거리 기반 자동 선택:
--   • 활성 직원(5분 이내 위치 갱신) 중 사고 구역과 가장 가까운 직원 식별
--   • urgent의 경우 가까운 순으로 상위 3명 동시 호출
-- SMS 발송: Ppurio API (PPURIO_USERNAME / PPURIO_API_KEY / PPURIO_SENDER 필요)
CREATE TABLE IF NOT EXISTS staff_calls (
  id BIGSERIAL PRIMARY KEY,
  staff_id TEXT,
  staff_name TEXT,
  zone_id TEXT,
  zone_name TEXT,
  message TEXT,
  urgency TEXT DEFAULT 'normal',       -- normal | high | urgent
  distance_meters INTEGER,
  sms_sent BOOLEAN DEFAULT FALSE,
  responded_at TIMESTAMPTZ,            -- Part D: 직원 앱 응답 시각
  called_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calls_staff ON staff_calls(staff_id, called_at);
CREATE INDEX IF NOT EXISTS idx_calls_zone  ON staff_calls(zone_id, called_at);
CREATE INDEX IF NOT EXISTS idx_calls_urgency ON staff_calls(urgency, called_at);

-- ────────────────────────────────────────
-- (선택) RLS 정책: service_role만 쓰기, 인증 사용자는 읽기 가능
-- ────────────────────────────────────────
ALTER TABLE auto_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auto_alerts_read" ON auto_alerts;
CREATE POLICY "auto_alerts_read" ON auto_alerts FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "staff_calls_read" ON staff_calls;
CREATE POLICY "staff_calls_read" ON staff_calls FOR SELECT TO authenticated USING (true);

-- service_role은 RLS 자동 우회 — INSERT/UPDATE는 API에서 수행

-- ────────────────────────────────────────
-- (선택) 30일 자동 정리 — pg_cron 확장 필요 시 주석 해제
-- ────────────────────────────────────────
-- SELECT cron.schedule('cleanup_alerts', '0 3 * * *', $$
--   DELETE FROM auto_alerts WHERE created_at < NOW() - INTERVAL '30 days';
--   DELETE FROM staff_calls WHERE called_at < NOW() - INTERVAL '90 days';
-- $$);

-- ════════════════════════════════════════════════════════════════
-- 적용 후 확인
-- ════════════════════════════════════════════════════════════════
-- SELECT COUNT(*) FROM auto_alerts;  -- 0 이어야 함 (방금 생성)
-- SELECT COUNT(*) FROM staff_calls;  -- 0
-- \d auto_alerts                    -- 컬럼/인덱스 확인
-- \d staff_calls
