// api_handlers/chatbot.js
// 잠사박물관 통합관리 AI 작업 도우미 (Phase 3 — 듀얼 AI 종합 의견)
// - mode: 'auto' (기본) | 'claude' | 'openai' | 'consensus' (둘 다 호출 + 종합)
// - Claude + OpenAI 동시 호출 시 차이/공통점 자동 비교 후 종합 카드 반환
// - 위험 작업(재고변경/알림발송/일정생성)은 반드시 requiresConfirmation: true

import { applyCors, checkRateLimit } from '../lib/auth.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-opus-4-7';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const OPENAI_MODEL      = process.env.OPENAI_MODEL      || 'gpt-4o';

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
  answer: '💡 죄송하지만 해당 질문에 대한 정확한 답변을 찾지 못했습니다. "재고", "안전", "캘린더", "알림" 같은 키워드로 다시 물어보시거나, ANTHROPIC_API_KEY / OPENAI_API_KEY를 설정하시면 더 정교한 AI 답변을 받을 수 있습니다.',
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

function buildUserMessage({ question, context, userRole, currentPage }) {
  return [
    currentPage ? `[현재 화면] ${currentPage}` : '',
    `[사용자 권한] ${userRole}`,
    context ? `[참고 데이터]\n${String(context).slice(0, 1500)}` : '',
    `[질문]\n${question}`,
  ].filter(Boolean).join('\n\n');
}

function parseJsonCard(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

async function callClaude(userMessage, { maxTokens = 900 } = {}) {
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
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!r.ok) {
    const err = await r.text().catch(()=>'');
    throw new Error(`Claude HTTP ${r.status}: ${err.slice(0, 150)}`);
  }
  const data = await r.json();
  const text = data?.content?.[0]?.text || '';
  const card = parseJsonCard(text) || {
    answer: text.trim() || '응답을 생성하지 못했습니다.',
    confidence: 'medium', category: 'help', data_source: ['claude'], actions: [],
  };
  return { card, raw: text, usage: data?.usage || null, model: ANTHROPIC_MODEL };
}

async function callOpenAI(userMessage, { maxTokens = 900 } = {}) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!r.ok) {
    const err = await r.text().catch(()=>'');
    throw new Error(`OpenAI HTTP ${r.status}: ${err.slice(0, 150)}`);
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const card = parseJsonCard(text) || {
    answer: text.trim() || '응답을 생성하지 못했습니다.',
    confidence: 'medium', category: 'help', data_source: ['openai'], actions: [],
  };
  return { card, raw: text, usage: data?.usage || null, model: OPENAI_MODEL };
}

// 두 카드의 차이/공통점을 분석해 종합 카드 생성
function mergeCards(claudeRes, openaiRes, fallbackActions) {
  const c = claudeRes?.card;
  const o = openaiRes?.card;

  // 어느 한쪽만 성공한 경우
  if (c && !o) return { primary: c, providers: { claude: c }, consensus: 'claude_only' };
  if (o && !c) return { primary: o, providers: { openai: o }, consensus: 'openai_only' };
  if (!c && !o) return null;

  // 둘 다 성공: 일치도 계산
  const confLevel = { high: 3, medium: 2, low: 1 };
  const cConf = confLevel[c.confidence] || 2;
  const oConf = confLevel[o.confidence] || 2;
  const sameCategory = c.category === o.category;
  const similar = stringSimilarity(c.answer, o.answer) > 0.55;

  // confidence가 더 높은 쪽을 primary로
  const primary = (cConf >= oConf) ? c : o;
  const secondary = (cConf >= oConf) ? o : c;
  const primaryProvider = (cConf >= oConf) ? 'claude' : 'openai';
  const secondaryProvider = (cConf >= oConf) ? 'openai' : 'claude';

  // actions 합치기 (중복 제거)
  const mergedActions = [];
  const seen = new Set();
  [...(c.actions || []), ...(o.actions || [])].forEach(a => {
    const key = `${a.type}:${JSON.stringify(a.payload || {})}`;
    if (!seen.has(key)) { seen.add(key); mergedActions.push(a); }
  });

  // 종합 답변 본문
  let combinedAnswer;
  if (similar && sameCategory) {
    // 두 모델이 일치 → 한 답으로 통합
    combinedAnswer = `🤝 **두 AI 모두 동일한 결론** (${primaryProvider} confidence=${primary.confidence})\n\n${primary.answer}`;
  } else if (sameCategory) {
    // 카테고리는 같으나 표현 차이 → 양쪽 정리
    combinedAnswer = `📊 **종합 의견** (카테고리: ${primary.category})\n\n` +
      `▸ Claude (${c.confidence}): ${c.answer}\n\n` +
      `▸ GPT (${o.confidence}): ${o.answer}\n\n` +
      `→ 권장: ${primary.answer.split('.')[0]}.`;
  } else {
    // 견해 갈림 → 명시
    combinedAnswer = `⚠ **두 AI 의견이 갈립니다** — 사람 판단 필요\n\n` +
      `▸ Claude (${c.category}, ${c.confidence}): ${c.answer}\n\n` +
      `▸ GPT (${o.category}, ${o.confidence}): ${o.answer}`;
  }

  return {
    primary: {
      answer: combinedAnswer,
      confidence: similar && sameCategory ? primary.confidence : 'medium',
      category: primary.category,
      data_source: ['claude+openai', ...(primary.data_source || [])],
      actions: mergedActions.length ? mergedActions : fallbackActions,
    },
    providers: { claude: c, openai: o },
    consensus: similar && sameCategory ? 'agree' : sameCategory ? 'partial' : 'disagree',
    similarity: stringSimilarity(c.answer, o.answer),
  };
}

// Jaccard 유사도 (한글 토큰 단위)
function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  const tokenize = s => new Set(s.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
  const A = tokenize(a); const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach(t => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });

  const body = req.body || {};
  // backward compatible: 기존 호출자는 message, 신규는 question
  const question = (body.question || body.message || '').toString();
  const context = body.context || '';
  const userRole = body.userRole || 'master';
  const currentPage = body.currentPage || '';
  // mode: 'auto' | 'claude' | 'openai' | 'consensus' | 'both' (=consensus 별명)
  let mode = (body.mode || 'auto').toLowerCase();
  if (mode === 'both' || mode === 'dual') mode = 'consensus';
  if (!question.trim()) return res.status(400).json({ ok: false, error: 'missing_question' });

  // auto 모드 + 두 키 모두 있음 → consensus가 더 풍부한 답을 줌
  if (mode === 'auto' && ANTHROPIC_API_KEY && OPENAI_API_KEY) {
    // 짧은 단순 질문은 단일 모델로 답해 비용 절약
    const isShortQuery = question.trim().length < 20 && !/(왜|어떻게|차이|비교|평가|분석|판단|결정)/.test(question);
    if (!isShortQuery) mode = 'consensus';
  }

  // mode 정규화: 요청한 모드에 필요한 키가 없으면 가능한 단일 모델로 자동 downgrade
  let modeRequested = mode;
  if (mode === 'consensus' && !(ANTHROPIC_API_KEY && OPENAI_API_KEY)) {
    // consensus 요청했는데 키 한쪽만 있음 → 가능한 단일 모델로
    mode = ANTHROPIC_API_KEY ? 'claude' : OPENAI_API_KEY ? 'openai' : 'auto';
  }
  if (mode === 'claude' && !ANTHROPIC_API_KEY && OPENAI_API_KEY) mode = 'openai';
  if (mode === 'openai' && !OPENAI_API_KEY && ANTHROPIC_API_KEY) mode = 'claude';

  const userMessage = buildUserMessage({ question, context, userRole, currentPage });
  const wantConsensus = mode === 'consensus' && ANTHROPIC_API_KEY && OPENAI_API_KEY;
  const wantClaude    = (mode === 'claude' || mode === 'auto') && ANTHROPIC_API_KEY;
  const wantOpenAI    = (mode === 'openai' || mode === 'auto') && OPENAI_API_KEY && !wantClaude;

  // 종합 의견 (consensus): 둘 다 병렬 호출 후 머지
  if (wantConsensus) {
    const fallbackActions = ruleBasedCard(question).actions;
    const [claudeR, openaiR] = await Promise.allSettled([
      callClaude(userMessage),
      callOpenAI(userMessage),
    ]);
    const claudeOk = claudeR.status === 'fulfilled' ? claudeR.value : null;
    const openaiOk = openaiR.status === 'fulfilled' ? openaiR.value : null;
    const claudeErr = claudeR.status === 'rejected' ? String(claudeR.reason?.message || claudeR.reason) : null;
    const openaiErr = openaiR.status === 'rejected' ? String(openaiR.reason?.message || openaiR.reason) : null;

    const merged = mergeCards(claudeOk, openaiOk, fallbackActions);
    if (!merged) {
      // 둘 다 실패 → 룰 기반 fallback
      const card = ruleBasedCard(question);
      return res.status(200).json({
        ok: true, ...card, source: 'rule_based',
        mode_requested: 'consensus',
        errors: { claude: claudeErr, openai: openaiErr },
      });
    }
    return res.status(200).json({
      ok: true,
      ...merged.primary,
      source: 'consensus',
      mode_used: 'consensus',
      providers: merged.providers,
      consensus: merged.consensus,
      similarity: merged.similarity,
      models: { claude: claudeOk?.model, openai: openaiOk?.model },
      usage: { claude: claudeOk?.usage, openai: openaiOk?.usage },
      errors: (claudeErr || openaiErr) ? { claude: claudeErr, openai: openaiErr } : undefined,
    });
  }

  // 단일 OpenAI 모드
  if (wantOpenAI || (mode === 'auto' && !ANTHROPIC_API_KEY && OPENAI_API_KEY)) {
    try {
      const { card, usage, model } = await callOpenAI(userMessage);
      if (!card.actions || card.actions.length === 0) {
        card.actions = ruleBasedCard(question).actions;
      }
      return res.status(200).json({
        ok: true, ...card,
        source: 'openai', model, mode_used: 'openai', usage,
      });
    } catch (e) {
      console.warn('[chatbot] OpenAI failed:', e.message);
    }
  }

  // 단일 Claude 모드 (기본)
  if (wantClaude) {
    try {
      const { card, usage, model } = await callClaude(userMessage);
      if (!card.actions || card.actions.length === 0) {
        card.actions = ruleBasedCard(question).actions;
      }
      return res.status(200).json({
        ok: true, ...card,
        source: 'claude', model, mode_used: 'claude', usage,
      });
    } catch (e) {
      console.warn('[chatbot] Claude failed:', e.message);
      // Claude 실패 시 OpenAI로 fallback
      if (OPENAI_API_KEY && mode === 'auto') {
        try {
          const { card, usage, model } = await callOpenAI(userMessage);
          if (!card.actions || card.actions.length === 0) {
            card.actions = ruleBasedCard(question).actions;
          }
          return res.status(200).json({
            ok: true, ...card,
            source: 'openai_fallback', model, mode_used: 'openai',
            usage, note: 'Claude 호출 실패로 OpenAI로 fallback',
          });
        } catch (e2) {
          console.warn('[chatbot] OpenAI fallback failed:', e2.message);
        }
      }
    }
  }

  // 모든 API 실패 또는 키 미설정 → 룰 기반
  const card = ruleBasedCard(question);
  return res.status(200).json({
    ok: true, ...card, source: 'rule_based',
    mode_used: 'rule_based',
    available: {
      claude: !!ANTHROPIC_API_KEY,
      openai: !!OPENAI_API_KEY,
    },
    setup_hint: (!ANTHROPIC_API_KEY && !OPENAI_API_KEY)
      ? '💡 Claude 또는 OpenAI 답변을 사용하려면 Vercel 환경변수에 ANTHROPIC_API_KEY 또는 OPENAI_API_KEY를 설정하세요.'
      : null,
  });
}
