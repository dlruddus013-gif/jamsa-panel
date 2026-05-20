// lib/ai-vision.js
// Claude / OpenAI 통합 Vision 호출기
// 환경변수:
//   ANTHROPIC_API_KEY, ANTHROPIC_MODEL (기본 claude-sonnet-4-20250514)
//   OPENAI_API_KEY, OPENAI_MODEL (기본 gpt-4o)
//   DEFAULT_AI_PROVIDER ('claude' | 'openai', 기본 claude)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-sonnet-4-20250514';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const OPENAI_MODEL      = process.env.OPENAI_MODEL      || 'gpt-4o';
const DEFAULT_PROVIDER  = (process.env.DEFAULT_AI_PROVIDER || 'claude').toLowerCase();

export function getAvailableProviders() {
  return {
    claude: !!ANTHROPIC_API_KEY,
    openai: !!OPENAI_API_KEY,
    default: DEFAULT_PROVIDER,
    models: { claude: ANTHROPIC_MODEL, openai: OPENAI_MODEL },
  };
}

// provider 정규화
function pickProvider(requested) {
  const want = (requested || '').toLowerCase();
  if (want === 'openai' && OPENAI_API_KEY) return 'openai';
  if (want === 'claude' && ANTHROPIC_API_KEY) return 'claude';
  // auto: 환경변수 default → 사용 가능한 것 → 둘 다 없으면 null
  if (DEFAULT_PROVIDER === 'openai' && OPENAI_API_KEY) return 'openai';
  if (DEFAULT_PROVIDER === 'claude' && ANTHROPIC_API_KEY) return 'claude';
  if (ANTHROPIC_API_KEY) return 'claude';
  if (OPENAI_API_KEY) return 'openai';
  return null;
}

/**
 * Vision API 호출 (Claude or OpenAI)
 * @param {object} opts
 * @param {string} opts.prompt    - 사용자 지시문
 * @param {string} opts.imageB64  - "data:image/jpeg;base64,..." 형태
 * @param {string} [opts.provider] - 'claude' | 'openai' | undefined(auto)
 * @param {number} [opts.maxTokens=1500]
 * @returns {Promise<{ok, provider, model, text, parsed, error?}>}
 */
export async function callVision({ prompt, imageB64, provider, maxTokens = 1500 }) {
  const chosen = pickProvider(provider);
  if (!chosen) {
    return { ok: false, error: 'no_api_key', message: 'ANTHROPIC_API_KEY 또는 OPENAI_API_KEY가 환경변수에 설정되어 있지 않습니다.' };
  }

  const m = (imageB64 || '').match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) return { ok: false, error: 'invalid_image' };
  const mediaType = m[1];
  const data = m[2];

  try {
    if (chosen === 'claude') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            ],
          }],
        }),
      });
      if (!r.ok) {
        const errText = await r.text();
        return { ok: false, provider: 'claude', model: ANTHROPIC_MODEL, error: 'api_error', status: r.status, raw: errText.slice(0, 300) };
      }
      const j = await r.json();
      const text = (j.content || []).map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) {}
      return { ok: true, provider: 'claude', model: ANTHROPIC_MODEL, text, parsed };
    }

    // openai
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } },
          ],
        }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      return { ok: false, provider: 'openai', model: OPENAI_MODEL, error: 'api_error', status: r.status, raw: errText.slice(0, 300) };
    }
    const j = await r.json();
    const text = (j.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {}
    return { ok: true, provider: 'openai', model: OPENAI_MODEL, text, parsed };
  } catch (e) {
    return { ok: false, provider: chosen, error: 'internal_error', message: e.message };
  }
}
