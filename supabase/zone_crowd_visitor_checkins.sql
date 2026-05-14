-- supabase/zone_crowd_visitor_checkins.sql
-- 누락된 두 테이블 (zone_crowd_stats, visitor_checkins) 생성용 마이그레이션
-- 적용 방법: Supabase Dashboard → SQL Editor → New query → 붙여넣기 → Run

-- ─────────────────────────────────────────────────────────────────────
-- 1) zone_crowd_stats — 구역별 인파 통계 (CCTV AI 분석 결과)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.zone_crowd_stats (
  id              BIGSERIAL PRIMARY KEY,
  zone_id         TEXT NOT NULL,
  channel_ch      INTEGER,
  people_count    INTEGER NOT NULL DEFAULT 0,
  confidence      REAL NOT NULL DEFAULT 0,
  crowd_level     TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (crowd_level IN ('LOW','MEDIUM','HIGH','CRITICAL','UNKNOWN')),
  source          TEXT NOT NULL DEFAULT 'cctv_ai',
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crowd_zone_time ON public.zone_crowd_stats (zone_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_crowd_recorded  ON public.zone_crowd_stats (recorded_at DESC);

-- RLS: 누구나 read, service_role만 write
ALTER TABLE public.zone_crowd_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crowd_read  ON public.zone_crowd_stats;
DROP POLICY IF EXISTS crowd_write ON public.zone_crowd_stats;
CREATE POLICY crowd_read  ON public.zone_crowd_stats FOR SELECT TO authenticated USING (true);
CREATE POLICY crowd_write ON public.zone_crowd_stats FOR INSERT TO service_role  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────
-- 2) visitor_checkins — 관람객 QR 체크인 (동선 분석)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.visitor_checkins (
  id               BIGSERIAL PRIMARY KEY,
  visitor_id       TEXT NOT NULL,
  zone_id          TEXT NOT NULL,
  zone_name        TEXT,
  checkpoint_type  TEXT NOT NULL DEFAULT 'entry' CHECK (checkpoint_type IN ('entry','exit','experience')),
  checked_in_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkin_visitor_time ON public.visitor_checkins (visitor_id, checked_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkin_zone_time    ON public.visitor_checkins (zone_id, checked_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkin_time         ON public.visitor_checkins (checked_in_at DESC);

ALTER TABLE public.visitor_checkins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checkin_read  ON public.visitor_checkins;
DROP POLICY IF EXISTS checkin_write ON public.visitor_checkins;
CREATE POLICY checkin_read  ON public.visitor_checkins FOR SELECT TO authenticated USING (true);
CREATE POLICY checkin_write ON public.visitor_checkins FOR INSERT TO service_role  WITH CHECK (true);

-- 적용 확인
-- SELECT count(*) FROM public.zone_crowd_stats;
-- SELECT count(*) FROM public.visitor_checkins;
