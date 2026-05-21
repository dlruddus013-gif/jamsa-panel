// api/ai-status.js
// 인증 없이 AI 환경변수 설정 상태만 노출하는 공개 endpoint
// (API 키는 절대 노출하지 않음 — boolean과 모델명만)

import { getAvailableProviders } from '../lib/ai-vision.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const info = getAvailableProviders();
    const anyConfigured = info.claude || info.openai;
    res.json({
      ok: true,
      ready: anyConfigured,
      providers: {
        claude: { available: info.claude, model: info.claude ? info.models.claude : null },
        openai: { available: info.openai, model: info.openai ? info.models.openai : null },
      },
      default: info.default,
      hint: anyConfigured
        ? `${info.claude && info.openai ? '두 provider 모두' : info.claude ? 'Claude만' : 'OpenAI만'} 사용 가능 (기본: ${info.default})`
        : '⚠ 환경변수 미설정 — Vercel Dashboard → Settings → Environment Variables → ANTHROPIC_API_KEY 또는 OPENAI_API_KEY 추가 후 Redeploy 필요',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'internal_error', message: e.message });
  }
}
