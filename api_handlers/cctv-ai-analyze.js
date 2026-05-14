// api/cctv-ai-analyze.js
// CCTV 스냅샷 이미지를 Claude API로 분석하여 위험도 판단
// 환경변수: ANTHROPIC_API_KEY

import { requireAuth, audit } from '../lib/auth.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'api_key_not_configured',
      message: 'Vercel 환경변수에 ANTHROPIC_API_KEY를 설정해 주세요.',
    });
  }

  try {
    const { ch, zone, image, context } = req.body || {};

    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'missing_image', message: '이미지(base64)가 필요합니다.' });
    }

    if (image.length > 7_000_000) {
      return res.status(400).json({ error: 'image_too_large', message: '이미지가 너무 큽니다 (5MB 이하)' });
    }

    const m = image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!m) {
      return res.status(400).json({ error: 'invalid_image', message: '유효한 base64 이미지 형식이 아닙니다.' });
    }

    const promptText = `당신은 한국잠사박물관의 CCTV 보안 + 인파 분석 AI입니다. 이 CCTV 이미지를 분석하여 위험도와 인원수를 판단하고 JSON으로만 응답하세요 (코드블록/설명 절대 금지, 순수 JSON만):

{
  "level": "SAFE|WARNING|DANGER",
  "score": 0~100 위험도 숫자,
  "category": "정상|움직임|침입|화재|누수|동물|혼잡|기타",
  "summary": "한 줄 요약 (예: '미상 인물 1명 출입', '연기 감지', '정상')",
  "detail": "구체적 분석 2-3문장 (어떤 객체가 보이고 왜 위험한지)",
  "peopleCount": 화면에 보이는 사람 수 (추정값, 부분만 보이면 0.5명도 1명으로 카운트),
  "peopleConfidence": 0.0~1.0 카운트 신뢰도 (조명/각도 등에 따라),
  "crowdLevel": "EMPTY|LOW|MEDIUM|HIGH|VERY_HIGH (사람 수 기준: 0=EMPTY, 1-3=LOW, 4-10=MEDIUM, 11-25=HIGH, 26+=VERY_HIGH)",
  "objects": [
    {"type":"사람|동물|차량|화재|연기|물|기타","count":숫자,"location":"좌상|상|우상|좌|중앙|우|좌하|하|우하"}
  ],
  "actionRequired": "권장 조치 (예: '즉시 현장 확인', '관제 모니터링 강화', '조치 불필요')",
  "shouldNotify": true 또는 false (DANGER이거나 야간 침입 의심 시 true)
}

판단 기준 (한국잠사박물관 운영 맥락):
- DANGER (80-100): 화재/연기, 침입(영업외 시간 인적), 폭력, 누수/물난리, 사고, 과밀 위험(VERY_HIGH 25명+)
- WARNING (40-79): 미확인 큰 움직임, 영업시간 외 차량, 동물 진입, 비정상 혼잡(HIGH 11-25명)
- SAFE (0-39): 정상 출입, 정해진 직원 활동, 평소 풍경, 빈 공간

인원 카운트 가이드:
- 얼굴 식별 절대 안 함 (개인정보 보호)
- 그저 "사람 형태"가 몇 개 보이는지 카운트
- 부분만 보여도 1명으로 카운트
- 그림자/그림 등은 제외
- 어두운 조명/멀리 있는 사람은 confidence 낮춤

추가 컨텍스트:
- 채널: ${ch || 'unknown'}
- 구역: ${zone || 'unknown'}
- 추가 정보: ${context || '없음'}
- 현재 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`;

    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      ],
    }];

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        messages,
      }),
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error('[cctv-ai] Claude API error:', claudeResponse.status, errText);
      return res.status(claudeResponse.status === 429 ? 429 : 502).json({
        error: 'claude_api_error',
        status: claudeResponse.status,
        message: claudeResponse.status === 429
          ? 'Claude API 사용량 한도 초과. 잠시 후 다시 시도하세요.'
          : `Claude API 오류 (${claudeResponse.status})`,
      });
    }

    const data = await claudeResponse.json();
    const text = data.content
      .map(b => b.text || '')
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('[cctv-ai] JSON parse failed. Response:', text.slice(0, 500));
      return res.status(502).json({
        error: 'invalid_ai_response',
        message: 'AI 응답을 파싱할 수 없습니다.',
        raw: text.slice(0, 500),
      });
    }

    const result = {
      level: ['SAFE', 'WARNING', 'DANGER'].includes(parsed.level) ? parsed.level : 'SAFE',
      score: Math.max(0, Math.min(100, parseInt(parsed.score) || 0)),
      category: parsed.category || '정상',
      summary: parsed.summary || '정상',
      detail: parsed.detail || '',
      objects: Array.isArray(parsed.objects) ? parsed.objects : [],
      actionRequired: parsed.actionRequired || '조치 불필요',
      shouldNotify: parsed.shouldNotify === true,
      analyzedAt: new Date().toISOString(),
      ch,
      zone,
    };

    if (result.level === 'DANGER') {
      audit(ctx, 'cctv_danger_detected', `ch${ch}_${zone}`, {
        score: result.score,
        category: result.category,
        summary: result.summary,
      });
    }

    res.json({ ok: true, result });
  } catch (e) {
    console.error('[cctv-ai] error:', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
