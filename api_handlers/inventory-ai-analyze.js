// api/inventory-ai-analyze.js
// 재고 등록 시 사진+제품명을 받아 Claude API로 분석한 결과를 반환
// 환경변수: ANTHROPIC_API_KEY (Vercel 환경변수로 설정 필요)

import { requireAuth, audit } from '../lib/auth.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

const CATS = ["체험","물놀이","이동식 공구대","박물관용품","하우스용","생필품","바닥재거용","묶음용","교육용","사무용품","전시용","기타"];

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'api_key_not_configured',
      message: 'Vercel 환경변수에 ANTHROPIC_API_KEY를 설정해 주세요.'
    });
  }

  try {
    const { productName, zoneName, category, photos } = req.body || {};

    // 입력 검증
    if (!productName && (!Array.isArray(photos) || photos.length === 0)) {
      return res.status(400).json({
        error: 'missing_input',
        message: '제품명 또는 사진을 1장 이상 보내주세요.'
      });
    }

    // 사진이 너무 많으면 제한 (최대 4장, 토큰 절약)
    const limitedPhotos = Array.isArray(photos) ? photos.slice(0, 4) : [];

    // 사진 크기 제한 (각 5MB 이하)
    for (const p of limitedPhotos) {
      if (typeof p !== 'string') continue;
      if (p.length > 7_000_000) { // base64 인코딩 후 약 5MB 원본
        return res.status(400).json({
          error: 'photo_too_large',
          message: '사진 1장당 5MB 이하로 업로드해 주세요.'
        });
      }
    }

    // 메시지 구성
    const promptText = `당신은 한국잠사박물관의 재고 관리 AI입니다. 사진과 제품명을 분석하여 아래 JSON 형식으로만 응답하세요 (코드블록/설명 절대 금지, 순수 JSON만):

{
  "name": "제품명 추정 (사진에서 보이는 정확한 이름, 이미 입력되어 있으면 보완)",
  "cat": "${CATS.join('|')} 중 하나",
  "usage": "사용법 2-3문장 (구체적으로)",
  "usageBlocks": [
    {"icon":"🧒","label":"대상","desc":"한단어/짧게"},
    {"icon":"🧩","label":"용도","desc":"한단어/짧게"},
    {"icon":"⚠️","label":"주의","desc":"한단어/짧게"}
  ],
  "careGuide": "관리/보관 요령 2-3문장",
  "careIcons": [
    {"icon":"☀️","desc":"직사광선 X"},
    {"icon":"💧","desc":"건조 보관"},
    {"icon":"🌈","desc":"색상별 정리"},
    {"icon":"📅","desc":"분기별 점검"}
  ],
  "stockSchedule": "입출고 권장 시기 1-2문장",
  "monthlyPattern": [
    {"month":1,"intake":20,"outtake":10},
    {"month":2,"intake":80,"outtake":15},
    {"month":3,"intake":90,"outtake":40},
    {"month":4,"intake":80,"outtake":50},
    {"month":5,"intake":70,"outtake":60},
    {"month":6,"intake":30,"outtake":50},
    {"month":7,"intake":20,"outtake":100},
    {"month":8,"intake":20,"outtake":95},
    {"month":9,"intake":75,"outtake":70},
    {"month":10,"intake":85,"outtake":75},
    {"month":11,"intake":60,"outtake":50},
    {"month":12,"intake":30,"outtake":25}
  ],
  "minQty": 권장 적정재고 숫자,
  "unit": "단위 (개/박스/세트/롤/팩 등)",
  "supplier": "추천 발주처 종류",
  "marketPrice": {
    "min": 최저가 숫자(원),
    "max": 최고가 숫자(원),
    "avg": 평균가 숫자(원),
    "unit": "기준 단위 (예: 박스당)",
    "note": "시세 메모"
  },
  "purchaseLinks": [
    {"name":"도매꾹","url":"https://domeggook.com/main/search/index.php?sc_word=...","price":8500,"badge":"최저가","badgeColor":"green","tags":["🚚 무료배송","📦 100+ 할인"]},
    {"name":"쿠팡","url":"https://www.coupang.com/np/search?q=...","price":11800,"badge":"로켓배송","badgeColor":"blue","tags":["⭐ 4.5","🚀 다음날 도착"]},
    {"name":"네이버쇼핑","url":"https://search.shopping.naver.com/search/all?query=...","priceRange":"9500~14000","badge":"가격비교","badgeColor":"amber","tags":["🏪 다수 매장","💳 카드할인"]},
    {"name":"학원사","url":"https://...","price":13000,"badge":"교육특화","badgeColor":"purple","tags":["📜 세금계산서","🏛️ 기관납품"]}
  ],
  "tips": "구매 팁 1-2문장",
  "smartRecommendation": "구체적 추천 (예: 2월 말 도매꾹에서 100박스 일괄 구매 시 단가 5,950원으로 41% 절감)"
}

규칙:
- usageBlocks/careIcons는 시각화용 짧은 라벨
- monthlyPattern: 박물관 시즌(봄·가을 단체관람, 여름방학) 패턴 반영, 0-100 비율
- purchaseLinks: 4개. URL은 제품명 검색 쿼리 형태로
- badgeColor: green|blue|amber|purple|red 중
- 한국 시장 기준 합리적 추정값
- 박물관 운영 맥락(대량구매, 안전, 행사 시즌) 고려

현재 입력값:
- 제품명: ${productName || '(미입력 — 사진에서 추정 필요)'}
- 위치: ${zoneName || '미지정'}
- 카테고리(미정): ${category || '미정'}
${limitedPhotos.length ? `- 사진 ${limitedPhotos.length}장 첨부됨` : '- 사진 없음'}`;

    const content = [{ type: 'text', text: promptText }];

    // 사진 추가
    for (const ph of limitedPhotos) {
      if (typeof ph !== 'string') continue;
      const m = ph.match(/^data:(image\/[a-z]+);base64,(.+)$/);
      if (m) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: m[1], data: m[2] }
        });
      }
    }

    // Claude API 호출
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 3500,
        messages: [{ role: 'user', content }]
      })
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error('[inventory-ai] Claude API error:', claudeResponse.status, errText);
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
      console.error('[inventory-ai] JSON parse failed. Response:', text.slice(0, 500));
      return res.status(502).json({
        error: 'invalid_ai_response',
        message: 'AI 응답을 파싱할 수 없습니다. 다시 시도해 주세요.',
        raw: text.slice(0, 500),
      });
    }

    // 폴백 보정
    const productNameFinal = parsed.name || productName || '제품';
    const q = encodeURIComponent(productNameFinal);
    const fallbackLinks = [
      { name: '도매꾹', url: `https://domeggook.com/main/search/index.php?sc_word=${q}`, badge: '도매', badgeColor: 'green', tags: ['🚚 무료배송', '📦 대량할인'] },
      { name: '쿠팡', url: `https://www.coupang.com/np/search?q=${q}`, badge: '로켓배송', badgeColor: 'blue', tags: ['⭐ 4.5', '🚀 빠른도착'] },
      { name: '네이버쇼핑', url: `https://search.shopping.naver.com/search/all?query=${q}`, badge: '가격비교', badgeColor: 'amber', tags: ['🏪 다수매장', '💳 카드할인'] },
      { name: '11번가', url: `https://search.11st.co.kr/Search.tmall?kwd=${q}`, badge: '할인쿠폰', badgeColor: 'purple', tags: ['🎁 적립금', '🏷️ 쿠폰'] },
    ];

    if (!parsed.purchaseLinks || !Array.isArray(parsed.purchaseLinks) || parsed.purchaseLinks.length === 0) {
      parsed.purchaseLinks = fallbackLinks;
    } else {
      parsed.purchaseLinks = parsed.purchaseLinks.map((l, i) => ({
        name: l.name || fallbackLinks[i % fallbackLinks.length].name,
        url: (l.url && l.url.startsWith('http')) ? l.url : fallbackLinks[i % fallbackLinks.length].url,
        price: l.price,
        priceRange: l.priceRange,
        badge: l.badge || fallbackLinks[i % fallbackLinks.length].badge,
        badgeColor: l.badgeColor || fallbackLinks[i % fallbackLinks.length].badgeColor,
        tags: l.tags || fallbackLinks[i % fallbackLinks.length].tags,
      }));
    }

    if (!parsed.usageBlocks || !Array.isArray(parsed.usageBlocks)) {
      parsed.usageBlocks = [
        { icon: '📦', label: '용도', desc: parsed.cat || '일반' },
        { icon: '📍', label: '위치', desc: zoneName || '미지정' },
        { icon: '📝', label: '메모', desc: '상세 사용법 참고' },
      ];
    }

    if (!parsed.careIcons || !Array.isArray(parsed.careIcons)) {
      parsed.careIcons = [
        { icon: '☀️', desc: '직사광선 X' },
        { icon: '💧', desc: '습기 주의' },
        { icon: '🧹', desc: '청결 유지' },
        { icon: '📅', desc: '정기 점검' },
      ];
    }

    if (!parsed.monthlyPattern || !Array.isArray(parsed.monthlyPattern)) {
      parsed.monthlyPattern = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, intake: 50, outtake: 50 }));
    }

    // 감사 로그
    audit(ctx, 'inventory_ai_analyze', productNameFinal, {
      photoCount: limitedPhotos.length,
      zone: zoneName,
      cat: parsed.cat,
    });

    res.json({ ok: true, result: parsed });
  } catch (e) {
    console.error('[inventory-ai] error:', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
