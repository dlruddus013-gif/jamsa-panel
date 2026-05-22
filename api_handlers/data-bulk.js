// api/data-bulk.js - 한 번의 호출로 모든 데이터 반환 (성능 최적화)
// 잠사박물관 단일 org 전용 패널이므로 GET 은 공개 — 로그인 없이 다른 IP/기기에서도
// 동일한 지도/CCTV/게이트웨이 배치를 볼 수 있어야 함.
import { adminClient, publicReadContext } from '../lib/auth.js';

export default async function handler(req, res) {
  const ctx = publicReadContext(req, res);
  if (!ctx) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const SYNC_PREFIX = 'jamsa_';

  try {
    // 한 번의 쿼리로 모든 키-값 가져오기
    const { data, error } = await adminClient
      .from('kv_store')
      .select('key, value, updated_at')
      .eq('org_id', ctx.orgId)
      .like('key', `${SYNC_PREFIX}%`)
      .order('updated_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // 키-값 객체로 변환
    const result = {};
    for (const row of (data || [])) {
      result[row.key] = row.value;
    }

    // 짧은 캐시 — 다른 기기에서 새로고침 시 즉시 반영되도록
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.json({
      ok: true,
      count: Object.keys(result).length,
      data: result
    });
  } catch (e) {
    console.error('[data-bulk] error:', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
