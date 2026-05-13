// api/chatbot.js
// 잠사박물관 통합관리 시스템 챗봇
// - ANTHROPIC_API_KEY 있으면 Claude로 답변
// - 없으면 룰 기반 도움말 응답
// 인증 불필요 + IP rate limit

import { applyCors, checkRateLimit } from '../lib/auth.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// 최신 모델 기본값: Claude Opus 4.7 (사용자가 ANTHROPIC_MODEL env var로 override 가능)
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';

const SYSTEM_PROMPT = `당신은 "한국잠사박물관 통합관리 시스템"의 챗봇 도우미입니다.
이 시스템은 다음 기능을 가진 박물관 운영 관리 웹앱입니다:
- 📦 재고관리 (위치/카테고리 관리 + 입출고 + 적정재고 알림)
- 🛡️ 안전관리 (AI 위험성평가, 일일점검, 사고기록, 보험, 캘린더)
- 🗺️ 통합지도 (위성지도 + 구역 + 평면도 + 3D 모델)
- 📒 업무일지 (일/주/월/분기별)
- 📹 CCTV + AI 자동감지
- 🔌 IoT 안전제어 (Tapo + Roborock)
- 🌦️ 실시간 날씨 (기상청 API)
- 📊 종합 보고/알림 (텔레그램/SMS/이메일)
- 🌐 파노라마 평면도 부가기능

규칙:
1. 사용자 질문에 한국어로 2~5문장으로 답변하세요.
2. 사용법은 "메뉴 → 페이지 → 버튼" 형식으로 안내하세요.
3. 모르는 기능에 대해 추측하지 말고 "해당 기능은 확인이 필요합니다"라고 답하세요.
4. 친근하지만 간결하게 답변하세요. 이모지는 적절히만 사용.`;

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });

  const { question = '', context = '' } = req.body || {};
  if (!question.trim()) return res.status(400).json({ ok: false, error: 'missing_question' });

  // Claude API 사용 가능 시
  if (ANTHROPIC_API_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 600,
          system: SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: context ? `[참고 데이터]\n${context.slice(0, 1500)}\n\n[질문]\n${question}` : question,
          }],
        }),
      });
      if (!r.ok) {
        const err = await r.text().catch(()=>'');
        throw new Error(`Claude HTTP ${r.status}: ${err.slice(0,150)}`);
      }
      const data = await r.json();
      const answer = data?.content?.[0]?.text || '죄송합니다, 답변을 생성하지 못했습니다.';
      return res.status(200).json({
        ok: true, answer, source: 'claude',
        model: ANTHROPIC_MODEL,
        usage: data?.usage || null,
      });
    } catch (e) {
      console.warn('[chatbot] Claude failed, fallback:', e.message);
      // fallthrough to rule-based
    }
  }

  // 룰 기반 폴백 + Claude 설정 안내
  const answer = ruleBasedAnswer(question);
  return res.status(200).json({
    ok: true,
    answer,
    source: 'rule_based',
    setup_hint: ANTHROPIC_API_KEY
      ? null
      : '💡 Claude AI 답변을 사용하려면 Vercel 환경변수에 ANTHROPIC_API_KEY를 설정하세요. Anthropic Console (console.anthropic.com)에서 API 키를 발급받을 수 있습니다.',
    suggested_model: 'claude-opus-4-7',
  });
}

function ruleBasedAnswer(q) {
  const lower = q.toLowerCase();
  const rules = [
    { kw: ['재고', '입고', '출고'], a: '📦 재고관리 메뉴 → 제품 클릭 → 입고/출고/조정 버튼으로 처리합니다. QR/RFID로 빠른 입출고도 가능합니다.' },
    { kw: ['위치', '카테고리', '추가', '관리'], a: '📦 재고관리 → 우상단 "위치관리" 또는 "카테고리" 버튼 → 추가/수정/삭제 + 사용법 탭에 자세한 가이드가 있습니다.' },
    { kw: ['일정', '캘린더', '점검'], a: '🛡️ 안전관리 → 안전관리 캘린더 → "+ 일정 추가" 또는 "🤖 AI 자동 일정 생성" 버튼으로 일정을 만들 수 있습니다.' },
    { kw: ['ai', '자동', 'AI'], a: '🤖 AI는 안전 캘린더, 위험성 평가, 종합 리포트 등에서 활용됩니다. 캘린더 우상단 보라색 버튼 클릭 시 재고·날씨·CCTV 기반 자동 일정을 제안합니다.' },
    { kw: ['알림', '문자', '텔레그램', 'sms'], a: '📊 안전관리 → 종합 보고/알림 → 알림 설정 탭에서 텔레그램/SMS/이메일/카카오/웹훅을 활성화하세요. 텔레그램이 가장 쉽고 무료입니다.' },
    { kw: ['cctv', '카메라', '녹화'], a: '📹 CCTV 관제 메뉴 또는 안전관리 → IoT 안전제어 → Tapo 기기 탭에서 카메라 상태와 스냅샷을 확인할 수 있습니다.' },
    { kw: ['로보락', '청소', '로봇'], a: '🤖 안전관리 → IoT 안전제어 → Roborock 로봇 탭에서 시작/도킹/구역 청소 명령을 보낼 수 있습니다.' },
    { kw: ['날씨', '기상', '경보'], a: '🌦️ 통합지도 우상단의 날씨 위젯을 클릭하면 실시간 날씨와 기상청 발효 특보 + 구역별 권장 점검을 볼 수 있습니다.' },
    { kw: ['보험', '청구', '사고'], a: '📑 안전관리 → 보험 종합 관리 → 보유 보험 등록 후 사고 발생 시 "처리 가능성 분석"으로 자동 매칭됩니다.' },
    { kw: ['평면도', '3d', '파노라마'], a: '🗺️ 통합지도에서 구역 클릭 → 🗺️ 세부위치 / 3D 버튼 → 평면도/파노라마/3D 모델/모바일 스캔 4개 탭 활용.' },
    { kw: ['로그인', '비밀번호', '계정'], a: '관리자에게 계정 발급을 요청하세요. 기본 계정은 admin / 1234 (마스터)입니다.' },
    { kw: ['도움', '메뉴', '뭐 있'], a: '주요 기능: 📦재고 / 🛡️안전 / 🗺️지도 / 📹CCTV / 📒일지 / 📊보고/알림. 각 메뉴는 좌측 사이드바에서 접근 가능합니다.' },
  ];

  for (const r of rules) {
    if (r.kw.some(k => lower.includes(k))) return r.a;
  }
  return '💡 죄송하지만 해당 질문에 대한 정확한 답변을 찾지 못했습니다. "재고", "안전", "캘린더", "알림" 같은 키워드로 다시 물어보시거나, ANTHROPIC_API_KEY를 설정하시면 더 정교한 AI 답변을 받을 수 있습니다.';
}
