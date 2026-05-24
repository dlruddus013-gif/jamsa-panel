// api/labor-advice.js
// 노무관리 #hr 탭의 실제 Claude/GPT 응답 백엔드.
// 카테고리별 라우팅 (CLAUDE/GPT/DUAL) + RAG 사례 시스템 프롬프트 주입.
// 환경변수: ANTHROPIC_API_KEY (필수), OPENAI_API_KEY (DUAL/GPT 시)

// ─── 카테고리별 시스템 프롬프트 (legal-advisor 의 prompts.py 포트) ───
const CATEGORY_PROMPTS = {
  dismissal: `당신은 한국 노동법·근로기준법 전문 노무사입니다. 부당해고·해고예고·구제신청 관련 질문에 답합니다.

답변 형식 (반드시 마크다운, 섹션 헤더 ## 와 이모지 유지):
## 📌 결론
[2-3 문장으로 결론 명확히]

## 📖 법령 근거
- **근로기준법 제○조** (○○): 핵심 내용
- 관련 대법원 판례 (가능하면)

## 🔍 사안 분석
[사실관계 → 법리 적용]

## ✅ 권장 조치
1. **단기 (오늘~3일)**: 즉시 해야 할 일
2. **중기 (1~2주)**: 그 다음 단계
3. **장기**: 최종 목표

## 📂 필요 서식·증거
- 구체적 서류 목록

## ⚠️ 주의사항
- 시효·제척기간 (3개월 등)
- 흔한 함정

분량: 1,500-2,500자. 실제 노동위원회 구제신청·노동청 진정 절차 정확하게.`,

  severance: `당신은 한국 근로자퇴직급여보장법 전문 노무사입니다. 퇴직금·평균임금·DC/DB·중간정산 관련 질문에 답합니다.
[형식: ## 📌 결론 / ## 📖 법령 근거 / ## 🔍 사안 분석 + 계산 / ## ✅ 권장 조치 (단기/중기/장기) / ## 📂 필요 서식·증거 / ## ⚠️ 주의사항]
계산이 필요하면 평균임금 = 직전 3개월 임금총액 ÷ 90일 공식 사용. 1년 미만 청구권 없음 원칙 명시. 분량 1,500-2,500자.`,

  wages: `당신은 한국 근로기준법 임금 규정 전문 노무사입니다. 통상임금·포괄임금·연장근로수당·주휴수당·최저임금 관련 답변.
[형식 동일: ## 📌 결론 / 📖 법령 근거 / 🔍 사안 분석 + 계산 / ✅ 권장 조치 / 📂 필요 서식·증거 / ⚠️ 주의사항]
연장근로 1.5배, 야간 1.5배 추가 가산, 휴일 8시간 이내 1.5배·초과 2배 (공휴일 포함) 정확히. 분량 1,500-2,500자.`,

  unpaid_wage: `당신은 임금체불 노동청 진정·대지급금 전문 노무사입니다. 신고 절차·증거 수집·체불사업주 처벌 관련 실무 가이드.
[형식 동일] 노동청 진정 → 시정명령 → 검찰송치 → 형사처벌 단계별 안내. 대지급금 신청 조건 (도산/사실상 도산) 명시. 분량 1,500-2,500자.`,

  annual_leave: `당신은 연차유급휴가·휴가 규정 전문 노무사입니다. 발생기준·연차촉진·미사용수당 관련 답변.
[형식 동일] 1년 미만 1개월 개근 1일 (최대 11일), 1년 이상 15일, 3년차부터 2년마다 1일 가산 (최대 25일). 5인 미만 사업장 적용 제외 명시. 분량 1,200-2,000자.`,

  parental_leave: `당신은 육아휴직·출산휴가·육아기 단축근무 전문 노무사입니다.
[형식 동일] 육아휴직 통상임금 80% 상한 150만/하한 70만 (첫 3개월), 통상임금 50% 상한 120만/하한 70만 (4-12개월). 출산휴가 90일 (다태아 120일), 첫 60일 사업주, 잔여 30일 고용보험. 분량 1,500-2,500자.`,

  contract: `당신은 근로계약·수습기간·계약직 갱신기대권 전문 노무사입니다.
[형식 동일] 수습기간 90% 감액은 1년 이상 근로계약 한정. 기간제 2년 초과 시 무기계약직 전환 (사실상 정규직). 갱신기대권 인정 시 부당해고 구제 가능. 분량 1,500-2,500자.`,

  insurance_injury: `당신은 4대보험·산재보험 전문 노무사입니다. 산재 신청·출퇴근 재해·사용자 무가입 관련 답변.
[형식 동일] 산재는 근로복지공단 직접 신청 (회사 동의 불필요). 출퇴근 재해는 통상 경로·방법일 때 인정. 4대보험 미가입 시 가입신고 + 소급 보험료 추징 + 과태료. 분량 1,500-2,500자.`,

  harassment: `당신은 직장 내 괴롭힘·갑질·성희롱 전문 노무사입니다. 신고·조사·보복 대응 관련 답변.
[형식 동일] 근로기준법 제76조의2 (직장내 괴롭힘) + 제76조의3 (회사 조치 의무) 인용. 통화 당사자 녹음 합법 (통신비밀보호법 제3조). 5인 미만 사업장도 적용 (2021년 개정). 분량 1,500-2,500자, 따뜻한 톤으로 시작.`,

  unemployment: `당신은 실업급여·이직사유 정정 전문 노무사입니다.
[형식 동일] 자발적 퇴사도 권고사직 정황 입증 시 가능 (질병·임금체불·괴롭힘 등). 이직확인서 사유코드 잘못 시 정정 요구 가능 (회사 거부 시 고용센터 신청). 수급 기간: 가입기간 + 연령. 분량 1,200-2,000자.`,

  tax: `당신은 세무·연말정산·경정청구 전문 세무사 (노무 인접 영역) 입니다.
[형식 동일] 경정청구는 신고기한 종료일로부터 5년 이내. 연말정산 누락 공제 → 경정청구 환급. 종합소득세 신고 5월 (전년도 종합소득). 분량 1,000-2,000자.`,
};

const ROUTING = {
  dismissal: "CLAUDE", severance: "DUAL", wages: "DUAL", unpaid_wage: "CLAUDE",
  annual_leave: "GPT", parental_leave: "CLAUDE", contract: "CLAUDE",
  insurance_injury: "CLAUDE", harassment: "CLAUDE", unemployment: "GPT", tax: "GPT",
};

// ─── Claude API 호출 ───
//   userKey 가 있으면 그것을 우선 사용 (사용자 본인 키), 없으면 ENV
async function callClaude({ systemPrompt, userMessage, ragContext, maxTokens = 2000, userKey = "" }) {
  const apiKey = (userKey && userKey.startsWith("sk-ant-")) ? userKey : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "anthropic_key_missing",
    message: "Anthropic API 키 없음 — 본인 키 입력하시거나 Vercel 환경변수 ANTHROPIC_API_KEY 설정 필요" };

  const sysWithRag = ragContext
    ? `${systemPrompt}\n\n[참고 자료 — 카톡 상담방 실제 노무사 답변]\n${ragContext}\n\n위 별첨 사례의 노무사 답변 톤·접근 방식·법령 적용을 따라하세요. 답변 본문에 "(별첨 사례 1 참조)" 같은 형태로 인용 가능합니다. 원문을 그대로 베끼지는 마세요.`
    : systemPrompt;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system: sysWithRag,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return { ok: false, status: r.status, error: data?.error?.type || "claude_api_error",
        message: data?.error?.message || `HTTP ${r.status}` };
    }
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const tokens = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
    return { ok: true, text, tokens, model: data.model };
  } catch (e) {
    return { ok: false, error: "claude_network_error", message: e.message };
  }
}

// ─── OpenAI GPT 호출 ───
async function callGPT({ systemPrompt, userMessage, ragContext, maxTokens = 2000, userKey = "" }) {
  const apiKey = (userKey && userKey.startsWith("sk-")) ? userKey : process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "openai_key_missing",
    message: "OpenAI API 키 없음 — 본인 키 입력하시거나 Vercel 환경변수 OPENAI_API_KEY 설정 필요" };

  const sysWithRag = ragContext
    ? `${systemPrompt}\n\n[참고 자료 — 카톡 상담방 실제 노무사 답변]\n${ragContext}\n\n위 별첨 사례의 노무사 답변 톤·접근 방식·법령 적용을 따라하세요. 답변 본문에 "(별첨 사례 1 참조)" 같은 형태로 인용 가능합니다. 원문을 그대로 베끼지는 마세요.`
    : systemPrompt;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: sysWithRag },
          { role: "user", content: userMessage },
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return { ok: false, status: r.status, error: data?.error?.type || "openai_api_error",
        message: data?.error?.message || `HTTP ${r.status}` };
    }
    const text = data.choices?.[0]?.message?.content || "";
    const tokens = data.usage?.total_tokens || 0;
    return { ok: true, text, tokens, model: data.model };
  } catch (e) {
    return { ok: false, error: "openai_network_error", message: e.message };
  }
}

// 안전한 body 파싱 — Vercel은 보통 자동이지만 일부 케이스에서 미파싱
async function safeParseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  // stream으로 직접 읽기 (fallback)
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

// ─── 핸들러 ───
export default async function handler(req, res) {
  // GET → status 체크 (키 설정 여부)
  if (req.method === "GET") {
    const userA = req.headers["x-anthropic-key"] || "";
    const userO = req.headers["x-openai-key"] || "";
    return res.json({
      ok: true,
      keys: {
        anthropic: userA ? "user" : (process.env.ANTHROPIC_API_KEY ? "server" : "none"),
        openai: userO ? "user" : (process.env.OPENAI_API_KEY ? "server" : "none"),
      },
      message: "POST 로 { category, question, router?, ragSamples? } 보내세요",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = await safeParseBody(req).catch(e => ({ _parseError: e.message }));
  if (body._parseError) {
    return res.status(400).json({ error: "body_parse_failed", message: body._parseError });
  }
  const { category, question, router, ragSamples } = body || {};
  if (!category || !question) {
    return res.status(400).json({ error: "missing_fields", message: "category, question 필수",
      received: { category: !!category, question: !!question, bodyKeys: Object.keys(body || {}) } });
  }

  const systemPrompt = CATEGORY_PROMPTS[category];
  if (!systemPrompt) {
    return res.status(400).json({ error: "invalid_category", message: `알 수 없는 카테고리: ${category}` });
  }

  const effectiveRouter = router || ROUTING[category] || "CLAUDE";

  // 사용자 키 (헤더로 전달, 본인 키 우선 사용) — 로그에 기록하지 않음
  const userAnthropicKey = req.headers["x-anthropic-key"] || "";
  const userOpenaiKey = req.headers["x-openai-key"] || "";
  const keySource = {
    anthropic: userAnthropicKey ? "user" : (process.env.ANTHROPIC_API_KEY ? "server" : "none"),
    openai: userOpenaiKey ? "user" : (process.env.OPENAI_API_KEY ? "server" : "none"),
  };

  // RAG 컨텍스트 생성 — LLM이 원문 인용 가능하도록 명확히 라벨링
  // (callClaude/callGPT 가 내부에서 system 프롬프트에 자동 prepend)
  const ragContext = Array.isArray(ragSamples) && ragSamples.length > 0
    ? ragSamples.map((s, i) => `[별첨 사례 ${i + 1} — 출처: ${s.expert || "전문가"} 답변]
질문: ${s.q}
노무사 답변 원문: ${s.a}`).join("\n\n---\n\n")
    : "";

  const t0 = Date.now();

  try {
    // ─── CLAUDE 단독 ───
    if (effectiveRouter === "CLAUDE") {
      const r = await callClaude({ systemPrompt, userMessage: question, ragContext, userKey: userAnthropicKey });
      if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ ...r, keySource });
      return res.json({
        ok: true, router: "CLAUDE",
        mock: { claude: r.text, tokens: r.tokens },
        model: r.model, elapsedMs: Date.now() - t0, keySource,
      });
    }

    // ─── GPT 단독 ───
    if (effectiveRouter === "GPT") {
      const r = await callGPT({ systemPrompt, userMessage: question, ragContext, userKey: userOpenaiKey });
      if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ ...r, keySource });
      return res.json({
        ok: true, router: "GPT",
        mock: { gpt: r.text, tokens: r.tokens },
        model: r.model, elapsedMs: Date.now() - t0, keySource,
      });
    }

    // ─── DUAL (Claude + GPT 동시 호출 → Claude로 통합) ───
    if (effectiveRouter === "DUAL") {
      const [cR, gR] = await Promise.all([
        callClaude({ systemPrompt, userMessage: question, ragContext, maxTokens: 1500, userKey: userAnthropicKey }),
        callGPT({ systemPrompt, userMessage: question, ragContext, maxTokens: 1500, userKey: userOpenaiKey }),
      ]);
      const claudeOK = cR.ok ? cR.text : `(Claude 응답 실패: ${cR.message})`;
      const gptOK = gR.ok ? gR.text : `(GPT 응답 실패: ${gR.message})`;
      let finalText = "";
      let finalTokens = (cR.tokens || 0) + (gR.tokens || 0);
      // 둘 다 성공 시 통합 답변 생성
      if (cR.ok && gR.ok) {
        const integrate = await callClaude({
          systemPrompt: `당신은 두 AI 모델(Claude+GPT)의 노무 자문 답변을 통합하는 시니어 노무사입니다.
두 답변의 강점을 결합하여 일관된 단일 답변을 작성하세요.
형식: ## 📌 결론 / ## 📖 법령 근거 / ## 🔍 사안 분석 + 계산 / ## ✅ 권장 조치 / ## 📂 필요 서식·증거 / ## ⚠️ 주의사항
모순되는 부분은 둘 중 더 정확하거나 보수적인 쪽 채택.`,
          userMessage: `[원 질문]\n${question}\n\n[Claude 답변]\n${claudeOK}\n\n[GPT 답변]\n${gptOK}\n\n위 두 답변을 통합하여 최종 답변을 작성해주세요.`,
          maxTokens: 2500,
          userKey: userAnthropicKey,
        });
        if (integrate.ok) {
          finalText = integrate.text;
          finalTokens += integrate.tokens || 0;
        } else {
          finalText = claudeOK; // 통합 실패 시 Claude 답변
        }
      } else if (cR.ok) {
        finalText = claudeOK;
      } else if (gR.ok) {
        finalText = gptOK;
      } else {
        return res.status(502).json({ ok: false, error: "dual_both_failed",
          message: `Claude+GPT 모두 실패`, claude: cR, gpt: gR, keySource });
      }
      return res.json({
        ok: true, router: "DUAL",
        mock: {
          claude: cR.ok ? cR.text : "",
          gpt: gR.ok ? gR.text : "",
          final: finalText,
          tokens: finalTokens,
        },
        elapsedMs: Date.now() - t0, keySource,
      });
    }

    return res.status(400).json({ error: "invalid_router", message: `router는 CLAUDE/GPT/DUAL 중 하나` });

  } catch (e) {
    console.error("[labor-advice] error:", e);
    return res.status(500).json({
      error: "internal_error",
      message: e?.message || String(e),
      stack: process.env.NODE_ENV === "production" ? undefined : e?.stack,
      hint: "labor-advice 핸들러에서 예외 발생. 키 설정 또는 LLM API 응답을 확인하세요.",
    });
  }
}
