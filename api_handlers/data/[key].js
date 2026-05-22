// api/data/[key].js - KV store CRUD
// 잠사박물관 단일 org 전용 — GET 은 공개(누구나 같은 데이터를 봄),
// PUT/POST/DELETE 는 로그인된 멤버만 가능.
import { adminClient, requireAuth, publicReadContext, hasRole, audit, validateKey, validateValueSize } from '../../lib/auth.js';

export default async function handler(req, res) {
  const { key } = req.query;
  if (!validateKey(key)) {
    return res.status(400).json({ error: 'invalid_key', detail: 'must match jamsa_[a-z0-9_-]+' });
  }

  // ── GET: 데이터 읽기 (공개) ──
  if (req.method === 'GET') {
    const pub = publicReadContext(req, res);
    if (!pub) return;
    const { data, error } = await adminClient
      .from('kv_store')
      .select('value, updated_at, updated_by')
      .eq('org_id', pub.orgId)
      .eq('key', key)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'not_found', key });
    res.setHeader('Cache-Control', 'public, max-age=5');
    return res.json(data.value);
  }

  // 이하 쓰기/삭제는 인증 필요
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  // ── PUT/POST: 데이터 저장 (전체 교체) ──
  if (req.method === 'PUT' || req.method === 'POST') {
    if (!hasRole(ctx, 'admin', 'manager', 'inspector')) {
      return res.status(403).json({ error: 'insufficient_role', need: 'inspector+', have: ctx.role });
    }

    const value = req.body;
    if (value === undefined || value === null) {
      return res.status(400).json({ error: 'missing_body' });
    }
    if (!validateValueSize(value)) {
      return res.status(413).json({ error: 'value_too_large', maxBytes: 5 * 1024 * 1024 });
    }

    const { error } = await adminClient
      .from('kv_store')
      .upsert(
        { org_id: ctx.orgId, key, value, updated_by: ctx.user.id, updated_at: new Date().toISOString() },
        { onConflict: 'org_id,key' }
      );

    if (error) return res.status(500).json({ error: error.message });

    // 감사로그 (백그라운드, 응답 지연 없음)
    audit(ctx, 'KV_PUT', key, {
      size: JSON.stringify(value).length,
      itemCount: Array.isArray(value) ? value.length : (typeof value === 'object' ? Object.keys(value).length : 1),
    });

    return res.json({ ok: true, key, count: Array.isArray(value) ? value.length : 1 });
  }

  // ── DELETE: 컬렉션 삭제 ──
  if (req.method === 'DELETE') {
    if (!hasRole(ctx, 'admin', 'manager')) {
      return res.status(403).json({ error: 'insufficient_role', need: 'manager+', have: ctx.role });
    }

    const { error } = await adminClient
      .from('kv_store')
      .delete()
      .eq('org_id', ctx.orgId)
      .eq('key', key);

    if (error) return res.status(500).json({ error: error.message });

    audit(ctx, 'KV_DELETE', key, {});
    return res.json({ ok: true, key });
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
