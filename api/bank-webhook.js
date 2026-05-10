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
  const t = String(text).replace(/\s+/g, ' ').trim();

  // 금액 추출
  const amountMatch = t.match(/([\d,]+)\s*원/);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1].replace(/,/g, ''));
  if (!amount || amount <= 0) return null;

  // 일자 추출 (MM/DD or YYYY-MM-DD)
  let date = new Date().toISOString().slice(0, 10);
  const dateMatch = t.match(/(\d{2,4})[\/.\-](\d{1,2})[\/.\-]?(\d{1,2})?/);
  if (dateMatch) {
    let yy = dateMatch[1], mm = dateMatch[2], dd = dateMatch[3];
    if (yy.length === 2) {
      // MM/DD 형식
      dd = mm; mm = yy; yy = String(new Date().getFullYear());
    }
    date = `${yy.padStart(4, '20' + '0'.repeat(0))}-${String(mm).padStart(2, '0')}-${String(dd || '01').padStart(2, '0')}`;
  }

  // 종류 (출금/승인/이체/입금)
  let type = 'transfer';
  if (/(승인|체크승인|일시불|할부)/.test(t)) type = 'card';
  else if (/(입금|받음|입급)/.test(t)) type = 'income';
  else if (/(출금|이체|송금|자동이체)/.test(t)) type = 'transfer';

  // 거래처 (가맹점/적요) — 마지막 토큰들 중 한글이름 추출
  const vendorPatterns = [
    /일시불\s+(.+?)(?:\s+잔액|\s+카드|\s+승인|\s*$)/,
    /할부\s+(.+?)(?:\s+잔액|\s*$)/,
    /(?:출금|이체|송금)\s+(.+?)(?:\s+잔액|\s*$)/,
    /(?:가맹점|이용처)\s*[:：]?\s*(.+?)(?:\s+잔액|\s+승인|\s*$)/,
  ];
  let vendor = '';
  for (const re of vendorPatterns) {
    const m = t.match(re);
    if (m && m[1]) { vendor = m[1].trim(); break; }
  }
  if (!vendor) {
    // fallback: 마지막 의미있는 단어
    const tokens = t.split(/\s+/).filter(w => /[가-힣]/.test(w));
    vendor = tokens.slice(-3, -1).join(' ').slice(0, 50) || '미상';
  }

  // 잔액 추출
  let balance = null;
  const balMatch = t.match(/잔액\s+([\d,]+)\s*원/);
  if (balMatch) balance = Number(balMatch[1].replace(/,/g, ''));

  return { date, vendor: vendor.slice(0, 100), amount, type, balance, ref: '', memo: t.slice(0, 200) };
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

  // 토큰 검증
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '') || req.query.token || req.body?.token;
  if (TOKEN && token !== TOKEN) {
    return res.status(401).json({ error: 'invalid_token', hint: 'set BANK_WEBHOOK_TOKEN env var and pass via Authorization: Bearer <token>' });
  }

  try {
    const { text, sms, message, body } = req.body || {};
    const raw = text || sms || message || body || '';
    const parsed = parseBankSms(raw);
    if (!parsed) {
      return res.status(200).json({ ok: false, parsed: null, reason: 'unable_to_parse', raw });
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
