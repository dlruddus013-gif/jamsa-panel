#!/usr/bin/env node
// 보존 정책 cron — 설계 §6.1
// 매일 03:00 실행 권장. GitHub Actions 또는 외부 스케줄러에서 호출.
//
// 작업:
//  1) staff_locations 원본 좌표 90일 후 파기 (purge_expired_locations RPC 호출)
//  2) 일일 결과를 audit_logs 에 기록 (RPC 내부에서 수행)
//
// 사용: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/retention_cron.mjs

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error('[retention_cron] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  console.log(`[retention_cron] ${new Date().toISOString()} — starting`);

  const { data, error } = await sb.rpc('purge_expired_locations');
  if (error) {
    console.error('[retention_cron] purge_expired_locations failed:', error);
    process.exit(1);
  }
  const purged = (data && data[0] && data[0].purged_count) || 0;
  console.log(`[retention_cron] purged ${purged} expired location rows`);

  // (선택) 5년 이상 된 location_access_log 를 archive 테이블로 이동 — 운영 결정 필요
  // 현재는 영구 보존 정책 유지

  console.log(`[retention_cron] done`);
}

main().catch(e => { console.error(e); process.exit(1); });
