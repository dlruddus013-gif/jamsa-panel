#!/usr/bin/env node
// 감사 패키지 메일 발송 워커 — 설계 §11.2 경로 B
// audit_package_log 에서 delivery_status='pending' 행을 픽업해서 실제 발송.
//
// 사용:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   [RESEND_API_KEY=...] [MAIL_FROM=audit@thejamsa.com] \
//   node scripts/send_audit_packages.mjs
//
// 환경:
//   RESEND_API_KEY 가 있으면 Resend(https://resend.com)로 실제 발송
//   없으면 콘솔에 발송 시뮬레이션 출력 후 status='sent' 마킹 (시연 모드)
//
// 보안:
//   - 페이로드는 메일 본문에 직접 포함하지 않음 (크기·보안 양쪽 이슈)
//   - 메일 본문에는 SHA-256 + 요약 + 다운로드 안내만
//   - 실제 다운로드는 /api/audit-package/download (Phase 5+ 인프라)
//   - PGP 옵션 활성화 시 openpgp 라이브러리 필요 — 현재 zip_password 만 지원

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'audit@thejamsa.com';
const SITE_NAME = process.env.SITE_NAME || '한국잠사플레이팜';

if (!URL || !KEY) {
  console.error('[mail_worker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

function generatePassword() {
  // 12자, 영숫자 + 특수문자 1-2개
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + '!7';
}

function renderEmailBody({ name, period, sha256, sizeBytes, summary, password, packageId }) {
  return `
안녕하세요 ${name || '노무사'}님,

${SITE_NAME} 감사 패키지가 생성되었습니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 기간: ${period.start} ~ ${period.end}
🔐 무결성 해시 (SHA-256): ${sha256}
📏 크기: ${(sizeBytes / 1024).toFixed(1)} KB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 요약
• 동의 기록: ${summary.consent_count}건
• 정밀 위치 접근 로그: ${summary.access_count}건
• 출퇴근 정정 이력: ${summary.correction_count}건
• 일반 감사 로그: ${summary.audit_log_count}건

🔑 zip 패스워드: ${password}

다운로드: https://${process.env.VERCEL_URL || 'jamsa-panel.vercel.app'}/api/audit-package/download?id=${packageId}
(다운로드 링크는 7일 동안 유효합니다. 별도 패스워드로 zip 보호됩니다.)

본 패키지는 위치정보법 제16조 관리적 보호조치 및 근로기준법 제42조
근로자 명부 보존 의무에 따라 정기 발송되는 감사 증빙 자료입니다.

문의: ${MAIL_FROM}
${SITE_NAME} 통합관리 시스템
`.trim();
}

async function sendViaResend({ to, subject, body }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_KEY}`,
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject,
      text: body,
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`resend_failed_${r.status}: ${errText.slice(0, 200)}`);
  }
  const j = await r.json();
  return { provider: 'resend', id: j.id };
}

function simulateSend({ to, subject, body }) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`[SIMULATED] To: ${to}`);
  console.log(`[SIMULATED] Subject: ${subject}`);
  console.log('---');
  console.log(body);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  return { provider: 'simulated', id: 'sim-' + Date.now() };
}

async function processOne(row) {
  const subject = `[${SITE_NAME}] 감사 패키지 — ${row.period_start} ~ ${row.period_end}`;
  const password = generatePassword();
  const body = renderEmailBody({
    name: row.recipient_name,
    period: { start: row.period_start, end: row.period_end },
    sha256: row.package_sha256,
    sizeBytes: row.package_size_bytes,
    summary: row.payload_summary || {},
    password,
    packageId: row.id,
  });

  let result;
  try {
    if (RESEND_KEY) {
      result = await sendViaResend({ to: row.recipient_email, subject, body });
    } else {
      result = simulateSend({ to: row.recipient_email, subject, body });
    }
    await sb.from('audit_package_log')
      .update({
        delivery_status: 'sent',
        delivered_at: new Date().toISOString(),
        delivery_error: null,
      })
      .eq('id', row.id);
    await sb.from('audit_logs').insert({
      org_id: row.org_id,
      action: 'AUDIT_PACKAGE_SENT',
      resource: `audit_package_log:${row.id}`,
      payload: { provider: result.provider, message_id: result.id, recipient: row.recipient_email },
    });
    return { id: row.id, ok: true, provider: result.provider };
  } catch (e) {
    await sb.from('audit_package_log')
      .update({
        delivery_status: 'failed',
        delivery_error: String(e.message || e).slice(0, 500),
      })
      .eq('id', row.id);
    return { id: row.id, ok: false, error: String(e.message || e) };
  }
}

async function main() {
  console.log(`[mail_worker] ${new Date().toISOString()} — picking pending packages`);
  console.log(`[mail_worker] provider: ${RESEND_KEY ? 'resend' : 'simulated (no RESEND_API_KEY)'}`);

  const { data, error } = await sb
    .from('audit_package_log')
    .select('*')
    .eq('delivery_status', 'pending')
    .order('generated_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error('[mail_worker] fetch failed:', error);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log('[mail_worker] no pending packages — exiting');
    return;
  }

  console.log(`[mail_worker] processing ${data.length} pending package(s)`);
  let okCount = 0, failCount = 0;
  for (const row of data) {
    const r = await processOne(row);
    if (r.ok) { okCount++; console.log(`  ✓ ${r.id} (${r.provider})`); }
    else { failCount++; console.log(`  ✗ ${r.id}: ${r.error}`); }
  }
  console.log(`[mail_worker] done — sent=${okCount}, failed=${failCount}`);
}

main().catch(e => { console.error(e); process.exit(1); });
