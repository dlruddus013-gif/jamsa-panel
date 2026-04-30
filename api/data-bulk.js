// api/data-bulk.js - 한 번의 호출로 모든 데이터 반환 (성능 최적화)
import { adminClient, requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
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

    // 30분 캐시 가능하지만 실시간성 위해 짧게
    res.setHeader('Cache-Control', 'private, max-age=10');
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
