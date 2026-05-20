// api/spot-layout-vision.js
// 위성지도 이미지를 Claude/OpenAI Vision으로 분석하여 박물관 시설(spot)들의 픽셀 좌표 추정
// 환경변수: ANTHROPIC_API_KEY, OPENAI_API_KEY (둘 중 하나 이상)

import { requireAuth } from '../lib/auth.js';
import { callVision, getAvailableProviders } from '../lib/ai-vision.js';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    return res.json({ ok: true, ...getAvailableProviders() });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const avail = getAvailableProviders();
  if (!avail.claude && !avail.openai) {
    return res.status(500).json({
      error: 'api_key_not_configured',
      message: 'Vercel 환경변수에 ANTHROPIC_API_KEY 또는 OPENAI_API_KEY를 설정해 주세요.',
    });
  }

  try {
    const { image, spots, bounds, hint, provider } = req.body || {};

    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'missing_image', message: '위성지도 이미지(base64)가 필요합니다.' });
    }
    if (image.length > 8_000_000) {
      return res.status(400).json({ error: 'image_too_large', message: '이미지가 너무 큽니다 (6MB 이하)' });
    }
    if (!Array.isArray(spots) || spots.length === 0) {
      return res.status(400).json({ error: 'missing_spots', message: '시설(spot) 목록이 필요합니다.' });
    }

    const m = image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!m) {
      return res.status(400).json({ error: 'invalid_image', message: '유효한 base64 이미지 형식이 아닙니다.' });
    }

    const spotList = spots.map((s, i) =>
      `${i + 1}. id="${s.id}" 이름="${s.name}"${s.icon ? ` 아이콘=${s.icon}` : ''}${s.desc ? ` 설명="${s.desc}"` : ''}`
    ).join('\n');

    const promptText = `당신은 위성지도 분석 전문가입니다. 첨부된 위성지도 이미지는 한국잠사박물관 부지를 보여줍니다.

다음 시설(spot)들의 위치를 사진에서 찾아 픽셀 좌표를 비율(0.0~1.0)로 추정해 주세요.
이미지 좌상단이 (0,0), 우하단이 (1,1)입니다.

【대상 시설 목록】
${spotList}

【추가 컨텍스트】
${hint || '한국잠사박물관 — 농경/체험/누에과학관 중심의 박물관 부지. 일반적으로 입구·매표소·주차장은 외곽, 본관·전시관은 중앙, 농지/뽕밭은 후방, 창고는 측면에 위치.'}

【판단 기준】
- 건물의 모양/지붕 색상/주변 구조로 시설 유형 추론
- 흰색 텐트형 구조물 → 체험장/매점 가능성
- 회색/콘크리트 큰 건물 → 본관/전시관
- 검정 비닐로 덮인 영역 → 비닐천막 또는 농경지
- 녹색 잔디/논 영역 → 텃밭/뽕밭/광장
- 둥근/돔 구조 → 누에과학관
- 차량이 모인 영역 → 주차장
- 우상단의 흰 줄무늬 구조 → 온실
- 식별이 어려운 경우 confidence를 낮춤

JSON으로만 응답하세요 (코드블록/설명 절대 금지, 순수 JSON):

{
  "matches": [
    {
      "id": "spot id (입력 그대로)",
      "name": "시설 이름",
      "xPct": 0.0~1.0 (이미지 가로 비율),
      "yPct": 0.0~1.0 (이미지 세로 비율),
      "confidence": 0.0~1.0,
      "reason": "왜 이 위치로 판단했는지 1-2문장"
    }
  ],
  "uncertain": ["식별 신뢰도 낮은 spot id 배열"],
  "notes": "전체적인 분석 코멘트 1-2문장"
}

주의:
- 모든 spot에 대해 좌표를 제공 (식별 어려워도 추정 위치)
- 식별 어려운 spot은 confidence < 0.4로 표시
- 좌표는 반드시 0.0~1.0 범위`;

    const vis = await callVision({ prompt: promptText, imageB64: image, provider, maxTokens: 3000 });
    if (!vis.ok) {
      console.error('[spot-vision] vision call failed:', vis);
      return res.status(vis.status === 429 ? 429 : 502).json({
        error: vis.error || 'vision_api_error',
        status: vis.status,
        message: vis.message || (vis.status === 429
          ? `${vis.provider || 'AI'} API 사용량 한도 초과. 잠시 후 다시 시도하세요.`
          : `${vis.provider || 'AI'} API 오류${vis.status ? ' (' + vis.status + ')' : ''}`),
        raw: vis.raw,
      });
    }
    const parsed = vis.parsed;
    if (!parsed || typeof parsed !== 'object') {
      console.error('[spot-vision] JSON parse failed:', vis.text?.slice(0, 400));
      return res.status(502).json({
        error: 'invalid_ai_response',
        message: 'AI 응답을 파싱할 수 없습니다.',
        provider: vis.provider,
        raw: vis.text?.slice(0, 500),
      });
    }

    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];

    // 픽셀 비율 → lat/lng 변환 (bounds가 주어진 경우)
    let withCoords = matches;
    if (bounds && typeof bounds === 'object'
        && typeof bounds.south === 'number' && typeof bounds.north === 'number'
        && typeof bounds.west === 'number' && typeof bounds.east === 'number') {
      withCoords = matches.map(mt => {
        const x = Math.max(0, Math.min(1, parseFloat(mt.xPct) || 0));
        const y = Math.max(0, Math.min(1, parseFloat(mt.yPct) || 0));
        const lng = bounds.west + x * (bounds.east - bounds.west);
        const lat = bounds.north - y * (bounds.north - bounds.south); // y=0이 북쪽
        return {
          ...mt,
          xPct: x, yPct: y,
          confidence: Math.max(0, Math.min(1, parseFloat(mt.confidence) || 0)),
          lat, lng,
        };
      });
    }

    res.json({
      ok: true,
      matches: withCoords,
      uncertain: Array.isArray(parsed.uncertain) ? parsed.uncertain : [],
      notes: parsed.notes || '',
      provider: vis.provider,
      model: vis.model,
    });
  } catch (e) {
    console.error('[spot-vision] error:', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
