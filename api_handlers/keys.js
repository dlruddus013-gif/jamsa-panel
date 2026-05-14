// api/keys.js - 모든 컬렉션 목록
import { adminClient, requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { data, error } = await adminClient
    .from('kv_store')
    .select('key, value, updated_at, updated_by')
    .eq('org_id', ctx.orgId)
    .order('updated_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const result = (data || []).map(row => ({
    key: row.key,
    count: Array.isArray(row.value)
      ? row.value.length
      : (typeof row.value === 'object' && row.value !== null ? Object.keys(row.value).length : 1),
    size: JSON.stringify(row.value).length,
    modified: row.updated_at,
  }));

  res.json(result);
}
