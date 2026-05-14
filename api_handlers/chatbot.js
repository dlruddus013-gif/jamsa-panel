// api_handlers/chatbot.js
// 잠사박물관 통합관리 AI 작업 도우미 (Phase 2)
// - 단순 Q&A → 구조화된 답변 (텍스트 + actions + 확실도 + 근거)
// - Tool-call 안내: 프론트엔드가 action 버튼으로 직접 실행
// - ANTHROPIC_API_KEY 있으면 Claude Opus 4.7, 없으면 룰 기반
// - 위험 작업(재고변경/알림발송/일정생성)은 반드시 requiresConfirmation: true

import { applyCors, checkRateLimit } from '../lib/auth.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';

const SYSTEM_PROMPT = `당신은 한국잠사박물관 통합관리 시스템의 **운영 AI 비서**입니다.
단순 챗봇이 아니라 시설 검색, 재고 관리, 점검, 긴급 대응, 보고서 생성을 도와주는 작업 인터페이스입니다.

## 시스템 모듈
- 📦 재고관리: 위치/카테고리 + 입출고 + 적정재고 알림 + QR
- 🛡️ 안전관리: AI 위험성평가, 일일점검, 사고기록, 보험, 캘린더
- 🗺️ 통합지도: 위성지도 + 구역 마커 + 평면도 + 3D
- 📒 업무일지: 일/주/월/분기별
- 📹 CCTV: AI 자동감지 + 항시작동 모드
- 🔌 IoT: Tapo + Roborock + 자동화
- 🌦️ 날씨: 기상청 API 실시간 + 자동 권장 점검
- 📊 종합 보고/알림: 텔레그램/SMS/이메일/카카오

## 답변 원칙
1. **데이터베이스에 없는 사실은 단정하지 않는다.** "확인이 필요합니다"로 답변.
2. **위험 작업**(재고 변경, 알림 발송, 일정 생성)은 requiresConfirmation: true.
3. **사용자 권한 초과 정보**는 제공하지 않는다 (master / staff / viewer).
4. **답변은 짧고 실행 가능하게**. 긴 문장보다 actions 배열로 다음 단계를 제안한다.
5. **시설명/재고명 모호하면 후보 제시**.
6. **긴급상황**: 절차 → 연락 → 현장 확인 순서.
7. **추정/확인 정보 구분**: confidence를 솔직하게 (high/medium/low).

## 응답 형식 (반드시 JSON만)
{
  "answer": "사용자에게 보여줄 답변 (2~5문장, 한국어)",
  "confidence": "high | medium | low",
  "category": "facility | inventory | maintenance | emergency | alert | report | help",
  "data_source": ["manual", "facility_db", ...],
  "actions": [
    {
      "label": "지도에서 보기",
      "type": "focus_map" | "open_page" | "external_link" | "create_inventory" | "create_task" | "send_alert" | "generate_report",
      "payload": { ... },
      "requiresConfirmation": false
    }
  ]
}

## 액션 type 가이드
- focus_map: 지도로 이동 + payload.facilityName 강조
- open_page: 메뉴 페이지 이동 (payload.page = "map"|"products"|"safety:calendar"|"safety:insurance"|"safety:iot"|"safety:reports"|"safety:dashboard"|"safety:incident"|"panoramaAddon" 등)
- external_link: 외부 링크 (payload.url)
- create_inventory: 재고 등록 (위험)
- create_task: 점검 일정 생성 (위험)
- send_alert: 알림 발송 (위험, 2단계 확인 권장)
- generate_report: 보고서 생성

코드블록/설명 없이 **JSON만** 반환하세요.`;

const RULE_CARDS = [
  { kw: ['재고','입고','출고','품목'], card: {
    answer: '📦 재고는 좌측 사이드바 "재고관리" 메뉴에서 관리합니다. 제품을 클릭하면 입고/출고/조정 버튼이 나타나고, QR/RFID로 빠른 처리도 가능합니다.',
    confidence: 'high', category: 'inventory', data_source: ['manual'],
    actions: [
      { label: '📦 재고관리 열기', type: 'open_page', payload: { page: 'products' } },
      { label: '🏷️ 카테고리 관리', type: 'open_page', payload: { page: 'products', modal: 'categoryManager' } },
      { label: '📍 위치 관리', type: 'open_page', payload: { page: 'products', modal: 'locationManager' } },
    ],
  }},
  { kw: ['일정','캘린더','AI 자동 일정'], card: {
    answer: '📅 안전관리 → 안전관리 캘린더에서 일정을 만들 수 있습니다. "🤖 AI 자동 일정 생성" 버튼으로 재고·날씨·CCTV·업무일지 기반 자동 제안을 받을 수 있습니다.',
    confidence: 'high', category: 'maintenance', data_source: ['manual'],
    actions: [
      { label: '📅 캘린더 열기', type: 'open_page', payload: { page: 'safety:calendar' } },
      { label: '🤖 AI 자동 일정 생성', type: 'open_page', payload: { page: 'safety:calendar', trigger: 'ai_schedule' } },
    ],
  }},
  { kw: ['알림','텔레그램','sms','카카오','문자'], card: {
    answer: '🔔 안전관리 → 종합 보고/알림 → 알림 설정 탭에서 텔레그램/SMS/이메일/카카오/웹훅을 활성화합니다. 텔레그램이 가장 빠르고 무료입니다 (1분 설정).',
    confidence: 'high', category: 'alert', data_source: ['manual'],
    actions: [
      { label: '🔔 알림 설정 열기', type: 'open_page', payload: { page: 'safety:reports', tab: 'channels' } },
      { label: '📡 BotFather (텔레그램)', type: 'external_link', payload: { url: 'https://t.me/BotFather' } },
    ],
  }},
  { kw: ['긴급','사고','화재','대응'], card: {
    answer: '🚨 긴급상황 발생 시: ① 사고/아차사고 기록에 즉시 등록 → ② 보험 종합 관리에서 청구 가능성 확인 → ③ IoT 안전제어에서 전 카메라 녹화. CCTV 항시작동이 켜져 있으면 자동 감지·알림이 작동 중입니다.',
    confidence: 'high', category: 'emergency', data_source: ['manual'],
    actions: [
      { label: '🚨 사고 기록 등록', type: 'open_page', payload: { page: 'safety:incident' } },
      { label: '🔌 IoT 긴급제어', type: 'open_page', payload: { page: 'safety:iot', tab: 'emergency' } },
      { label: '📑 보험 처리', type: 'open_page', payload: { page: 'safety:insurance' } },
    ],
  }},
  { kw: ['보고서','리포트','요약','월간','주간'], card: {
    answer: '📊 안전관리 → 종합 보고/알림에서 시간대별 종합 보고서를 자동 생성합니다. 안전 대시보드의 월간 안전 리포트(🤖 AI 리포트 자동 생성)도 활용하세요.',
    confidence: 'high', category: 'report', data_source: ['manual'],
    actions: [
      { label: '📊 종합 보고서 열기', type: 'open_page', payload: { page: 'safety:reports', tab: 'report' } },
      { label: '🤖 AI 월간 리포트', type: 'open_page', payload: { page: 'safety:dashboard' } },
    ],
  }},
  { kw: ['cctv','카메라','녹화','항시작동'], card: {
    answer: '📹 통합지도 우상단 CCTV 라이브 패널의 "🔴 항시작동 (Always On)" 체크박스를 켜면 5초 주기 스냅샷 + 자동 재연결 + AI 위험분석이 항상 작동합니다.',
    confidence: 'high', category: 'facility', data_source: ['manual'],
    actions: [
      { label: '🗺️ 통합지도로 이동', type: 'open_page', payload: { page: 'map' } },
      { label: '🔌 IoT 카메라 관리', type: 'open_page', payload: { page: 'safety:iot', tab: 'devices' } },
    ],
  }},
  { kw: ['로보락','로봇','청소'], card: {
    answer: '🤖 안전관리 → IoT 안전제어 → Roborock 로봇 탭에서 시작/일시정지/도킹/구역청소 명령을 보냅니다. 박물관 PC에 Roborock 브릿지가 설치되어 있어야 실제 동작합니다.',
    confidence: 'medium', category: 'facility', data_source: ['manual'],
    actions: [
      { label: '🤖 Roborock 패널 열기', type: 'open_page', payload: { page: 'safety:iot', tab: 'robots' } },
    ],
  }},
  { kw: ['날씨','기상','경보','폭염','강풍','호우'], card: {
    answer: '🌦️ 통합지도 우상단 날씨 위젯을 클릭하면 실시간 기상청 특보와 영향 구역별 권장 점검을 볼 수 있습니다. "⚡ 전체 점검 등록"으로 facActions에 자동 등록됩니다.',
    confidence: 'high', category: 'facility', data_source: ['manual', 'kma_api'],
    actions: [
      { label: '🗺️ 지도 + 날씨 위젯', type: 'open_page', payload: { page: 'map' } },
    ],
  }},
  { kw: ['평면도','3d','파노라마','세부위치'], card: {
    answer: '🗺️ 통합지도에서 구역 클릭 → "🗺️ 세부위치/3D" 버튼 → 평면도/파노라마/3D 모델/모바일 스캔 4개 탭을 사용합니다. 부가기능으로 파노라마 평면도 자동 생성도 가능합니다.',
    confidence: 'high', category: 'facility', data_source: ['manual'],
    actions: [
      { label: '🗺️ 통합지도', type: 'open_page', payload: { page: 'map' } },
      { label: '🌐 파노라마 평면도', type: 'open_page', payload: { page: 'panoramaAddon' } },
    ],
  }},
  { kw: ['보험','청구','필요'], card: {
    answer: '📑 안전관리 → 보험 종합 관리: 보유 보험 등록 + 사고 자동 매칭 + 청구 진행 상태 + 박물관 필수 보험 누락 분석을 한 곳에서 처리합니다.',
    confidence: 'high', category: 'help', data_source: ['manual'],
    actions: [
      { label: '📑 보험 관리 열기', type: 'open_page', payload: { page: 'safety:insurance' } },
    ],
  }},
];

const FALLBACK_CARD = {
  answer: '💡 죄송하지만 해당 질문에 대한 정확한 답변을 찾지 못했습니다. "재고", "안전", "캘린더", "알림" 같은 키워드로 다시 물어보시거나, ANTHROPIC_API_KEY를 설정하시면 더 정교한 AI 답변을 받을 수 있습니다.',
  confidence: 'low', category: 'help', data_source: [],
  actions: [
    { label: '📦 재고관리', type: 'open_page', payload: { page: 'products' } },
    { label: '🛡️ 안전 대시보드', type: 'open_page', payload: { page: 'safety:dashboard' } },
    { label: '🗺️ 통합지도', type: 'open_page', payload: { page: 'map' } },
  ],
};

function ruleBasedCard(q) {
  const lower = q.toLowerCase();
  for (const r of RULE_CARDS) {
    if (r.kw.some(k => lower.includes(k))) return r.card;
  }
  return FALLBACK_CARD;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });

  const { question = '', context = '', userRole = 'master', currentPage = '' } = req.body || {};
  if (!question.trim()) return res.status(400).json({ ok: false, error: 'missing_question' });

  if (ANTHROPIC_API_KEY) {
    try {
      const userMessage = [
        currentPage ? `[현재 화면] ${currentPage}` : '',
        `[사용자 권한] ${userRole}`,
        context ? `[참고 데이터]\n${String(context).slice(0, 1500)}` : '',
        `[질문]\n${question}`,
      ].filter(Boolean).join('\n\n');

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 900,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!r.ok) {
        const err = await r.text().catch(()=>'');
        throw new Error(`Claude HTTP ${r.status}: ${err.slice(0,150)}`);
      }
      const data = await r.json();
      const text = data?.content?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      let card;
      try { card = jsonMatch ? JSON.parse(jsonMatch[0]) : null; } catch (e) { card = null; }
      if (!card || !card.answer) {
        card = {
          answer: text.trim() || '응답을 생성하지 못했습니다.',
          confidence: 'medium', category: 'help', data_source: ['claude'], actions: [],
        };
      }
      if (!card.actions || card.actions.length === 0) {
        card.actions = ruleBasedCard(question).actions;
      }
      return res.status(200).json({
        ok: true, ...card,
        source: 'claude', model: ANTHROPIC_MODEL,
        usage: data?.usage || null,
      });
    } catch (e) {
      console.warn('[chatbot] Claude failed, fallback:', e.message);
    }
  }

  const card = ruleBasedCard(question);
  return res.status(200).json({
    ok: true, ...card, source: 'rule_based',
    setup_hint: ANTHROPIC_API_KEY ? null
      : '💡 Claude AI 답변을 사용하려면 Vercel 환경변수에 ANTHROPIC_API_KEY를 설정하세요 (console.anthropic.com).',
    suggested_model: 'claude-opus-4-7',
  });
}
