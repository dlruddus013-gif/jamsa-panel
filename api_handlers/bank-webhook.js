// api/bank-webhook.js
// 은행/카드사 푸시 알림 webhook 수신 (Tasker/Macrodroid 등에서 SMS 텍스트를 POST)
// 또는 카드사/은행 알림톡 자동전달 서비스에서 호출
//
// 권장 운영: 안드로이드폰에 Tasker 설치 → "은행 알림 텍스트 캡처 → POST /api/bank-webhook"
// 권한 토큰: BANK_WEBHOOK_TOKEN 환경변수와 일치해야 통과

import { supabaseSvc } from '../lib/auth.js';

const TOKEN = process.env.BANK_WEBHOOK_TOKEN;

// 한국 은행/카드 알림 텍스트 파싱
// 예: "[KB]04/30 13:45 NH체크승인 1234** 14,500원 일시불 GS25서울역점 잔액 320,000원"
//     "신한은행 04/30 14:20 출금 50,000원 잔액 270,000원 발신: 홈택스"
function parseBankSms(text) {
  if (!text) return null;
  const t = String(text).replace(/[ ]/g, ' ').replace(/\s+/g, ' ').trim();

  // 1) 금액 추출 — "원" 또는 ",000원" 패턴, 잔액 제외
  // "14,500원 일시불" 또는 "출금 50,000원" 우선 매칭
  let amount = 0;
  const amtPriority = [
    /(?:일시불|할부|승인|출금|이체|송금|입금|결제)\s*[:：]?\s*([\d,]+)\s*원/,
    /([\d,]+)\s*원\s*(?:일시불|할부|승인)/,
    /([\d,]+)\s*원/,
  ];
  for (const re of amtPriority) {
    const m = t.match(re);
    if (m) {
      const v = Number(m[1].replace(/,/g, ''));
      // "잔액 X원" 패턴은 제외
      const idx = m.index || 0;
      const prefix = t.slice(Math.max(0, idx - 10), idx);
      if (/잔액|잔고|residual/i.test(prefix)) continue;
      if (v > 0) { amount = v; break; }
    }
  }
  if (!amount) return null;

  // 2) 일자 추출 — 2025/05/10, 25/05/10, 5/10, 5-10 등
  let date = new Date().toISOString().slice(0, 10);
  const fullDate = t.match(/(20\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
  const shortDate = t.match(/(?:^|[\s\[\(])(\d{1,2})[\/.\-](\d{1,2})(?:[\s\)\]]|$)/);
  const dotDate = t.match(/(\d{2})[\/.\-](\d{2})[\/.\-](\d{2})/);
  if (fullDate) {
    date = `${fullDate[1]}-${fullDate[2].padStart(2,'0')}-${fullDate[3].padStart(2,'0')}`;
  } else if (dotDate) {
    const yy = Number(dotDate[1]) > 50 ? `19${dotDate[1]}` : `20${dotDate[1]}`;
    date = `${yy}-${dotDate[2].padStart(2,'0')}-${dotDate[3].padStart(2,'0')}`;
  } else if (shortDate) {
    const now = new Date();
    date = `${now.getFullYear()}-${shortDate[1].padStart(2,'0')}-${shortDate[2].padStart(2,'0')}`;
  }

  // 3) 종류 — 우선순위: 카드 키워드 > 입금 > 출금
  let type = 'transfer';
  if (/(승인|체크승인|일시불|할부|결제됨|이용)/.test(t) && !/이체/.test(t)) type = 'card';
  else if (/(입금|받음|입급|받으셨)/.test(t)) type = 'income';
  else if (/(출금|이체|송금|자동이체|납부)/.test(t)) type = 'transfer';

  // 4) 거래처 추출 — 은행/카드사별 패턴
  const vendorPatterns = [
    // 카드사 일반: "일시불 GS25잠사역점", "할부 다이소"
    /(?:일시불|할부|승인)\s+([^\s][^()\[\]]*?)(?:\s*\(?잔액|\s+\d+개월|\s*\(\d|\s*$)/,
    // 은행 출금: "출금 50,000원 잔액 X원 (주)도매꾹" - 출금 뒤 적요
    /(?:출금|이체|송금)\s+[\d,]+\s*원[^원]*?잔액\s+[\d,]+\s*원\s+(.+?)(?:\s*$|\s+\[)/,
    // 은행 적요: "적요:공급사" or "적요 공급사"
    /적요\s*[:：]\s*(.+?)(?:\s*$|\s+\[|\s+잔액)/,
    // 가맹점/이용처 명시
    /(?:가맹점|이용처|이용가맹점)\s*[:：]?\s*(.+?)(?:\s+잔액|\s+승인|\s+\(|\s*$)/,
    // NH체크승인 후: "NH체크승인 1234** 14,500원 일시불 GS25잠사역점"
    /(?:NH체크승인|체크승인)[^\d]*\d+[*\d]*\s+[\d,]+\s*원[^원]*?(?:일시불|할부)?\s+(.+?)(?:\s+잔액|\s*$)/,
    // 송금/이체 받은 곳: "이체 (주)도매꾹"
    /(?:송금|이체)[\s를]+([가-힣A-Za-z][^()]*?)(?:\s+잔액|\s+\d|\s*$)/,
  ];
  let vendor = '';
  for (const re of vendorPatterns) {
    const m = t.match(re);
    if (m && m[1]) {
      vendor = m[1].trim().replace(/^[:：\s]+|[:：\s]+$/g, '');
      // 너무 짧거나 숫자만이면 다음 패턴
      if (vendor.length >= 2 && /[가-힣A-Za-z]/.test(vendor)) break;
      vendor = '';
    }
  }
  if (!vendor) {
    // fallback: 마지막 한글 토큰
    const tokens = t.split(/\s+/).filter(w => /[가-힣]/.test(w) && !/^(원|잔액|승인|출금|입금|이체|일시불|할부|박물관|계좌|발신)$/.test(w));
    vendor = tokens.slice(-2).join(' ').slice(0, 50) || '미상';
  }
  // "잠사역점", "잠사점" 등 박물관 자체 거래는 그대로 유지
  vendor = vendor.replace(/\(\)|\[\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);

  // 5) 잔액
  let balance = null;
  const balMatch = t.match(/잔액\s*[:：]?\s*([\d,]+)\s*원/);
  if (balMatch) balance = Number(balMatch[1].replace(/,/g, ''));

  // 6) 발신처 추출 (은행/카드사명)
  let issuer = '';
  const issuerMatch = t.match(/\[(KB국민|KB|국민|신한|우리|Woori|농협|NH|하나|기업|IBK|카카오|토스|새마을|삼성|현대|롯데|BC|비씨)(?:카드|은행|뱅크)?\]/i);
  if (issuerMatch) issuer = issuerMatch[1];

  return {
    date, vendor, amount, type, balance,
    ref: '', issuer,
    memo: t.slice(0, 200),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: 최근 webhook 수신 내역 (디버깅용)
  if (req.method === 'GET') {
    if (!supabaseSvc) return res.status(200).json({ ok: true, rows: [] });
    const { data } = await supabaseSvc
      .from('payments_imported').select('*')
      .eq('source', 'bank_webhook')
      .order('imported_at', { ascending: false }).limit(20);
    return res.status(200).json({ ok: true, rows: data || [] });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // 미리보기 모드 — 파싱만 하고 저장 안 함 (모달의 SMS 테스트 패널용)
  const previewMode = req.query.preview === '1' || req.body?.preview === true;

  // 토큰 검증 (미리보기 모드는 토큰 불필요)
  if (!previewMode) {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '') || req.query.token || req.body?.token;
    if (TOKEN && token !== TOKEN) {
      return res.status(401).json({ error: 'invalid_token', hint: 'set BANK_WEBHOOK_TOKEN env var and pass via Authorization: Bearer <token>' });
    }
  }

  try {
    const { text, sms, message, body } = req.body || {};
    const raw = text || sms || message || body || '';
    const parsed = parseBankSms(raw);
    if (!parsed) {
      return res.status(200).json({ ok: false, parsed: null, reason: '금액/일자를 찾을 수 없음 (SMS 본문 전체를 붙여넣어 보세요)', raw });
    }

    // 미리보기 모드는 저장 없이 파싱 결과만 반환
    if (previewMode) {
      return res.status(200).json({ ok: true, parsed, mode: 'preview' });
    }

    // 저장 (Supabase 사용 가능 시)
    if (supabaseSvc) {
      try {
        await supabaseSvc.from('payments_imported').upsert({
          ...parsed,
          source: 'bank_webhook',
          format: 'sms_push',
          raw_data: { raw, ua: req.headers['user-agent'] || '' },
          imported_at: new Date().toISOString(),
        }, { onConflict: 'date,amount,vendor', ignoreDuplicates: true });
      } catch (e) {
        // 테이블 없어도 무시 (200 반환)
      }
    }

    res.status(200).json({ ok: true, parsed });
  } catch (e) {
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
