// api/payment-import.js
// 결제 내역 일괄 저장 — 클라이언트 파싱 결과를 받아 Supabase payments_imported 테이블에 INSERT
// (Supabase 미설정 또는 테이블 미생성 시에도 200 OK 반환, 클라 localStorage만 사용)

import { supabaseSvc } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const { rows = [], source = 'manual', format = '' } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'no_rows' });
    }

    // 클라이언트 단독 모드 — Supabase 미설정 시
    if (!supabaseSvc) {
      return res.status(200).json({ ok: true, mode: 'client_only', count: rows.length });
    }

    // 중복 키: date + amount + vendor (UPSERT)
    const records = rows.map(r => ({
      date: String(r.date || '').slice(0, 10) || null,
      vendor: String(r.vendor || '').trim().slice(0, 200),
      amount: Math.round(Math.abs(Number(r.amount) || 0)),
      type: r.type || 'card',
      ref: String(r.ref || '').slice(0, 100),
      memo: String(r.memo || '').slice(0, 500),
      source: source || r.source || 'manual',
      format,
      raw_data: r,
      imported_at: new Date().toISOString(),
    })).filter(r => r.date && r.amount > 0);

    const { data, error } = await supabaseSvc
      .from('payments_imported')
      .upsert(records, { onConflict: 'date,amount,vendor', ignoreDuplicates: true })
      .select('id');

    if (error) {
      // 테이블이 없는 경우에도 클라이언트 작동에 영향 X
      if (/relation .* does not exist|payments_imported/i.test(error.message || '')) {
        return res.status(200).json({ ok: true, mode: 'client_only', count: records.length, hint: 'supabase/payments_import.sql 실행 필요' });
      }
      throw error;
    }

    res.status(200).json({ ok: true, mode: 'supabase', count: data?.length || 0, total: records.length });
  } catch (e) {
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
