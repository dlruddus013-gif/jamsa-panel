// api/search.js - jsonb 검색
import { adminClient, requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const q = (req.query.q || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);

  if (!q) {
    return res.json({ query: '', matches: [] });
  }

  // Postgres RPC 호출 (search_kv 함수)
  const { data, error } = await adminClient.rpc('search_kv', {
    p_org_id: ctx.orgId,
    p_query: q,
    p_limit: limit,
  });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const matches = (data || []).map(row => ({
    collection: row.collection,
    index: row.item_index,
    item: row.item,
    preview: (row.preview || '').slice(0, 100),
  }));

  res.json({ query: q, matches });
}
