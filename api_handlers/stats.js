// api/stats.js
import { adminClient, requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { data, error } = await adminClient.rpc('kv_stats', {
    p_org_id: ctx.orgId,
  });

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    ...(data || {}),
    org_id: ctx.orgId,
    role: ctx.role,
    user: ctx.user.email,
  });
}
