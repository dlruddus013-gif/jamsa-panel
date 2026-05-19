-- ════════════════════════════════════════════════════════════════
-- 결제 내역 자동 import 테이블
-- 용도: 엑셀 업로드 / 은행 webhook / 오픈뱅킹 자동동기화 결과 저장
-- 실행 위치: Supabase 프로젝트 → SQL Editor → Run
-- 의존성: 없음 (기존 schema와 독립)
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payments_imported (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  vendor TEXT NOT NULL,
  amount BIGINT NOT NULL,
  type TEXT DEFAULT 'card',          -- card | transfer | income
  ref TEXT,                           -- 승인번호/거래번호
  memo TEXT,
  source TEXT,                        -- '홈택스' | '카드사' | '은행' | 'openbanking' | 'bank_webhook'
  format TEXT,                        -- hometax_purchase | hometax_card_in | bank_transaction | card_statement | sms_push | auto_sync
  raw_data JSONB,                     -- 원본 행 데이터 보존
  req_id BIGINT,                      -- (선택) 품의 연동 ID
  imported_at TIMESTAMPTZ DEFAULT NOW(),

  -- 중복 방지: 같은 일자 + 금액 + 거래처는 1건으로 합침
  UNIQUE (date, amount, vendor)
);

CREATE INDEX IF NOT EXISTS idx_pay_imp_date    ON payments_imported(date DESC);
CREATE INDEX IF NOT EXISTS idx_pay_imp_vendor  ON payments_imported(vendor);
CREATE INDEX IF NOT EXISTS idx_pay_imp_source  ON payments_imported(source, imported_at);
CREATE INDEX IF NOT EXISTS idx_pay_imp_type    ON payments_imported(type, date);

-- ────────────────────────────────────────
-- RLS 정책
-- ────────────────────────────────────────
ALTER TABLE payments_imported ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pay_imp_read" ON payments_imported;
CREATE POLICY "pay_imp_read" ON payments_imported FOR SELECT TO authenticated USING (true);

-- service_role은 RLS 우회 — INSERT/UPDATE는 API에서 수행

-- ────────────────────────────────────────
-- 월별 집계 뷰 (운영 통계 모달에서 활용 가능)
-- ────────────────────────────────────────
CREATE OR REPLACE VIEW v_payments_monthly AS
SELECT
  DATE_TRUNC('month', date)::DATE AS month,
  type,
  source,
  COUNT(*) AS tx_count,
  SUM(amount) AS total_amount
FROM payments_imported
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;

-- ────────────────────────────────────────
-- (선택) 90일 자동 정리 — pg_cron
-- ────────────────────────────────────────
-- SELECT cron.schedule('cleanup_payments', '0 4 * * *', $$
--   DELETE FROM payments_imported WHERE imported_at < NOW() - INTERVAL '180 days';
-- $$);

-- ════════════════════════════════════════════════════════════════
-- 적용 후 확인
-- ════════════════════════════════════════════════════════════════
-- SELECT COUNT(*) FROM payments_imported;
-- SELECT * FROM v_payments_monthly LIMIT 10;
