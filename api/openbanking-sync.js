// api/openbanking-sync.js
// 금융결제원 오픈뱅킹 API 자동 동기화 (5분 주기 폴링용)
// 환경변수 미설정 시 → ok:false + reason 반환 (클라이언트 에러 표시 X)
//
// 환경변수:
//   OPENBANKING_CLIENT_ID       — 오픈뱅킹 등록 앱 클라이언트 ID
//   OPENBANKING_CLIENT_SECRET   — 클라이언트 시크릿
//   OPENBANKING_ACCESS_TOKEN    — 사용자 access_token (이용기관용)
//   OPENBANKING_FINTECH_USE_NUM — 핀테크이용번호 (계좌별)
//
// 등록 절차: https://www.openbanking.or.kr → 이용기관 등록 → 앱 생성 → 토큰 발급
// 미등록 상태에서도 시스템은 정상 작동 (수동 업로드만 사용)

import { supabaseSvc } from '../lib/auth.js';

const CLIENT_ID = process.env.OPENBANKING_CLIENT_ID;
const ACCESS_TOKEN = process.env.OPENBANKING_ACCESS_TOKEN;
const FINTECH_USE_NUM = process.env.OPENBANKING_FINTECH_USE_NUM;
const OB_BASE = 'https://openapi.openbanking.or.kr';

async function fetchTransactions(since) {
  if (!ACCESS_TOKEN || !FINTECH_USE_NUM) return null;
  const fromDate = (since || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)).replace(/-/g, '');
  const toDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const params = new URLSearchParams({
    bank_tran_id: `M${Date.now()}`.slice(0, 20),
    fintech_use_num: FINTECH_USE_NUM,
    inquiry_type: 'A',
    inquiry_base: 'D',
    from_date: fromDate,
    to_date: toDate,
    sort_order: 'D',
    tran_dtime: new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14),
  });

  const res = await fetch(`${OB_BASE}/v2.0/account/transaction_list/fin_num?${params}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`openbanking_${res.status}`);
  const data = await res.json();
  if (data.rsp_code !== 'A0000') throw new Error(`openbanking_${data.rsp_code}: ${data.rsp_message}`);
  return data.res_list || [];
}

function normalize(tx) {
  // 오픈뱅킹 응답 필드 → 통합 결제 row
  const date = (tx.tran_date || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const out = Number(tx.tran_amt || 0) > 0 && tx.inout_type === '출금' ? Number(tx.tran_amt) : 0;
  const inn = Number(tx.tran_amt || 0) > 0 && tx.inout_type === '입금' ? Number(tx.tran_amt) : 0;
  return {
    date,
    vendor: (tx.print_content || tx.tran_content || '').trim(),
    amount: out > 0 ? out : inn,
    type: out > 0 ? 'transfer' : 'income',
    ref: tx.bank_tran_id || '',
    memo: `잔액 ${tx.after_balance_amt || 0}원`,
    source: '오픈뱅킹',
    raw: tx,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // 환경변수 미설정 안내
  if (!CLIENT_ID || !ACCESS_TOKEN || !FINTECH_USE_NUM) {
    return res.status(200).json({
      ok: false,
      reason: '오픈뱅킹 환경변수 미설정',
      configured: {
        OPENBANKING_CLIENT_ID: !!CLIENT_ID,
        OPENBANKING_ACCESS_TOKEN: !!ACCESS_TOKEN,
        OPENBANKING_FINTECH_USE_NUM: !!FINTECH_USE_NUM,
      },
      docs: 'https://www.openbanking.or.kr',
    });
  }

  try {
    const since = req.query.since || (req.body && req.body.since);
    const list = await fetchTransactions(since);
    if (!list) return res.status(200).json({ ok: false, reason: 'no_data' });

    const rows = list.map(normalize).filter(r => r.amount > 0 && r.date);

    // Supabase 저장
    if (supabaseSvc && rows.length > 0) {
      try {
        await supabaseSvc.from('payments_imported').upsert(
          rows.map(r => ({
            date: r.date, vendor: r.vendor, amount: r.amount,
            type: r.type, ref: r.ref, memo: r.memo,
            source: 'openbanking', format: 'auto_sync',
            raw_data: r.raw, imported_at: new Date().toISOString(),
          })),
          { onConflict: 'date,amount,vendor', ignoreDuplicates: true }
        );
      } catch (e) { /* 테이블 없어도 무시 */ }
    }

    res.status(200).json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(200).json({ ok: false, reason: e.message || 'sync_failed' });
  }
}
