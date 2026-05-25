// api_handlers/bridge-reset.js
// POST /api/bridge/reset — admin RBAC. 박물관 PC의 연결 워커를 재시작.
import { requireAuth, normalizeRole, audit } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (normalizeRole(ctx.role) !== 'admin') {
    return res.status(403).json({ ok: false, error: 'forbidden', detail: 'admin only' });
  }

  const bridgeUrl = process.env.BRIDGE_BASE_URL;
  if (!bridgeUrl) {
    return res.status(503).json({ ok: false, error: 'bridge_not_configured', detail: 'BRIDGE_BASE_URL 미설정' });
  }

  try {
    const ac = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(5000) : undefined;
    const r = await fetch(`${bridgeUrl.replace(/\/+$/, '')}/api/admin/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: 'bridge_error', status: r.status, bridge: data });
    }
    await audit(ctx, 'bridge_reset', null, { previousRetryCount: data?.previousRetryCount ?? null });
    return res.json({ ok: true, previousRetryCount: data?.previousRetryCount ?? null });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'bridge_unreachable', detail: e?.message || String(e) });
  }
}
