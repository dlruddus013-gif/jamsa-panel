// ============================================================
// 노무관리 (Labor Advisor) — Claude/GPT/RAG 듀얼 라우팅 자문 모듈
// jamsa-panel #hr 의 한 탭으로 통합. 데모 모드: 4개 카테고리는 풍부한
// 모의 응답 + 카톡 사례, 나머지 7개는 generic 스켈레톤 응답.
// 실제 서비스화하려면 fetchAdvice 를 FastAPI /api/consult 로 교체.
// ============================================================
import React, { useState, useMemo, useEffect } from "react";

// ─── 11개 카테고리 (자동 라우팅 규칙 + 예시 질문) ───
export const LABOR_CATEGORIES = [
  { k: "dismissal",      i: "⚖️", n: "해고·부당해고",        c: "#c0392b", r: "CLAUDE", d: "부당해고 구제신청, 해고예고수당, 권고사직 대응", rag: 8,
    ec: ["갑자기 내일부터 나오지 말라는데 부당해고인가요?", "권고사직 사인하라는데 거부해도 되나요?", "부당해고 구제신청 기한이 어떻게 되나요?"] },
  { k: "severance",      i: "💰", n: "퇴직금·퇴직급여",      c: "#d35400", r: "DUAL",   d: "퇴직금 계산, 1년 미만 근속, 평균임금, DC/DB", rag: 7,
    ec: ["주 6일 일하다 11개월만에 퇴사했는데 퇴직금 받을 수 있나요?", "퇴직금에 연차수당이 포함되나요?", "DC형 퇴직금 손실 발생시 청구 가능?"] },
  { k: "wages",          i: "💵", n: "임금·수당",            c: "#8e44ad", r: "DUAL",   d: "통상임금, 포괄임금, 연장·야간·휴일 가산, 주휴수당", rag: 8,
    ec: ["포괄임금제인데 연장수당 추가로 받을 수 있나요?", "주휴수당 계산 좀 도와주세요", "공휴일 근무시 1.5배인가요 2.5배인가요?"] },
  { k: "unpaid_wage",    i: "📋", n: "임금체불·진정",        c: "#c0392b", r: "CLAUDE", d: "임금체불 진정, 노동청 신고, 대지급금 신청", rag: 8,
    ec: ["월급을 두 달째 안 줍니다. 신고 절차?", "퇴직금 안 주는데 노동청 진정 가능?", "대지급금 신청 조건이 뭔가요?"] },
  { k: "annual_leave",   i: "🏖️", n: "연차·휴가",            c: "#16a085", r: "GPT",    d: "연차 발생기준, 미사용수당, 연차촉진제도", rag: 8,
    ec: ["1년 미만 근속자 연차는 어떻게 발생하나요?", "연차촉진서 받았는데 어떻게 대응하나요?", "퇴사시 미사용 연차 모두 보상받나요?"] },
  { k: "parental_leave", i: "👶", n: "육아휴직·출산휴가",    c: "#e67e22", r: "CLAUDE", d: "육아휴직 급여 계산, 출산휴가, 육아기 단축근무", rag: 0,
    ec: ["육아휴직 급여에 고정OT가 인정되나요?", "출산휴가 후 바로 육아휴직 쓸 수 있나요?", "회사가 육아휴직 거부할 수 있나요?"] },
  { k: "contract",       i: "📝", n: "근로계약·수습",        c: "#2980b9", r: "CLAUDE", d: "근로계약서, 수습기간 감액, 계약직 갱신기대권", rag: 8,
    ec: ["수습기간 임금 90% 지급이 합법인가요?", "근로계약서 안 쓰면 어떻게 되나요?", "계약직 3년 후 정규직 전환 의무 있나요?"] },
  { k: "insurance_injury", i: "🏥", n: "4대보험·산재",       c: "#27ae60", r: "CLAUDE", d: "산재 신청, 출퇴근 재해, 4대보험 자격", rag: 8,
    ec: ["출퇴근하다 사고 났는데 산재 되나요?", "회사가 4대보험 가입 안 해줍니다", "산재 신청하면 회사에 불이익 있나요?"] },
  { k: "harassment",     i: "🚨", n: "직장내괴롭힘·갑질",    c: "#e74c3c", r: "CLAUDE", d: "직장내괴롭힘 신고, 증거 수집, 보복 대응", rag: 3,
    ec: ["팀장이 매일 욕설을 합니다. 어떻게 대응?", "직장내괴롭힘 신고했더니 보복성 인사발령", "증거가 카톡뿐인데 인정될까요?"] },
  { k: "unemployment",   i: "📊", n: "실업급여·이직사유",    c: "#3498db", r: "GPT",    d: "실업급여 수급조건, 이직사유, 자발적 퇴사 인정", rag: 6,
    ec: ["자발적 퇴사인데 실업급여 받을 방법?", "회사가 실업급여 받게 해준다는데?", "이직확인서 코드가 잘못 됐어요"] },
  { k: "tax",            i: "🧾", n: "세무·연말정산",        c: "#7f8c8d", r: "GPT",    d: "연말정산 환급, 경정청구 5년치, 종합소득세", rag: 8,
    ec: ["5년 전 연말정산 다시 받을 수 있나요?", "경정청구는 어떻게 하나요?", "부양가족 공제 누락했을 때?"] },
];

// ─── RAG 샘플 (카톡 상담방 실제 노무사 답변 추출) ───
export const RAG_SAMPLES = {
  dismissal: [
    { expert: "섬이 노무사", q: "퇴직금받은날 갑자기 자진퇴사로 몰고가서 실업급여 못받게 하려는거같아요", a: "노동청 신고 하시고, 합의 보시는게 좋을 것 같습니다. 해고철회를 어떠한 방식으로 했는지 모르겠으나, 해고 자체가 존재했고 그것을 철회하는 과정이라면 오히려 해고예고수당 청구의 근거가 될 수 있습니다." },
    { expert: "섬이 노무사", q: "5인 이상 사업장에서 회사 인수합병으로 그만두라고 합니다", a: "5인 이상 사업장이면 함부로 회사가 해고 할 수도 없는 노릇이니, 거절하시거나 아니면 고용승계에 관한 계약서를 잘 작성하시는 것이 좋을 것 같아요" },
  ],
  severance: [
    { expert: "섬이 노무사", q: "퇴직금 계산기 믿을게 못된다고 하지만 퇴직전 3개월 임금으로 계산시", a: "퇴직금 구하시는 기간 3개월을 1월, 2월, 3월 4일까지 하셨다는거죠? 12월 5일 ~ 3월 4일까지 하신게 아니라? 평균임금 산정 기간은 사유 발생일 이전 3개월입니다." },
    { expert: "인사부장", q: "2025년도 미사용 연가보상비를 26년 1월에 지급, 퇴직금 계산시 3/12 적용 맞나요?", a: "민법 제662조(묵시의 갱신) 관련 조항에 따라 연가보상비 산입 처리... 평균임금 산정 직전 3개월에 지급된 연차수당은 3/12을 산입하는 것이 맞습니다." },
  ],
  annual_leave: [
    { expert: "섬이 노무사", q: "입사 6개월차인데 연차가 7일밖에 안 나왔어요", a: "1년 미만은 매월 개근시 1일씩 발생, 최대 11일까지입니다. 결근 1회당 해당 월 연차 미발생되니 출근부 확인하세요." },
    { expert: "섬이 노무사", q: "연차촉진서를 5월에 받았는데 효과가 있나요?", a: "연차사용촉진은 사용기간 만료 6개월 전 1차, 2개월 전 2차로 진행되어야 합니다. 시기·방식 요건 위반시 무효이며 미사용수당 청구 가능합니다." },
  ],
  harassment: [
    { expert: "섬이 노무사", q: "팀장이 매일 욕설을 합니다. 어떻게 해야 하나요?", a: "근로기준법 제76조의2 직장내괴롭힘에 해당할 가능성이 높습니다. 일시·장소·발언내용 메모, 가능하면 녹취(통화 당사자 녹음은 합법), 카톡 캡처 등 증거 수집 후 회사 인사팀에 서면 신고하세요. 회사가 적절히 조치 안하면 노동청 진정 가능합니다." },
  ],
};

// ─── 풍부한 모의 응답 (4개 카테고리). 나머지는 _generic 으로 폴백. ───
export const MOCK_ANSWERS = {
  dismissal: {
    claude: `## 📌 결론
서면 해고통지를 받지 못한 채 "내일부터 나오지 말라"는 통보는 근로기준법 제27조 위반으로 무효이며, 부당해고 구제신청이 가능합니다.

## 📖 법령 근거
- **근로기준법 제27조**(해고사유 등의 서면통지): 사용자는 근로자를 해고하려면 해고사유와 해고시기를 서면으로 통지해야 함.
- **근로기준법 제28조**(부당해고 구제신청): 해고일로부터 3개월 이내 노동위원회 구제신청 가능.
- **근로기준법 제26조**(해고예고): 30일 전 예고 또는 30일분 통상임금 지급.

## 🔍 사안 분석
- 구두 통보 + 서면 미수령 → 절차적 무효
- 30일 예고 결여 → 해고예고수당 청구권 발생
- 5인 미만 사업장이면 부당해고 구제신청 불가, 단 해고예고수당은 청구 가능

## ✅ 권장 조치
1. **단기 (오늘~3일)**: 통보 내용을 문자/카톡으로 회사에 회신하여 증거화. "구두 해고 통보를 받았으니 서면 통지를 요청합니다."
2. **중기 (2주 내)**: 사업장 상시근로자수 확인. 5인 이상이면 노동위원회 부당해고 구제신청.
3. **장기**: 임금·퇴직금 미정산분 별도 청구 (3년 시효).

## 📂 필요 서식·증거
- 근로계약서, 최근 3개월 급여명세서
- 해고 통보 당시 녹음·문자·카톡 캡처
- 사업자등록증 (상시근로자 수 확인용)

## ⚠️ 주의사항
- 구제신청 기한 3개월은 **제척기간**으로 절대 연장 불가
- 사직서 작성을 강요받아도 **절대 작성 금지** (자진사직 처리되어 구제 불가)
- 5인 미만이라도 해고예고수당 + 미지급 임금은 노동청 진정으로 받을 수 있음

💡 **RAG 참고**: 카톡에서 추출된 노무사 답변과 일관성 있게, "해고철회 후 자진퇴사 유도" 같은 변형 케이스도 해고예고수당 청구의 근거가 됨을 명시함.`,
    tokens: 1842,
  },
  severance: {
    claude: `## 📌 결론
주 15시간 이상 + 1년 미만(11개월) → 법정 퇴직금 청구권 없음. 단, 취업규칙·근로계약에 별도 유리 조항이 있으면 적용.

## 📖 법령 근거
- 근로자퇴직급여보장법 제4조: 1년 이상 + 주 15시간 이상이 발생 요건
- 동법 제8조: 퇴직금 산정공식

## 🔍 사안 분석
- 1년 미만이라는 점이 결정적
- 단, 사용자가 1년 회피 목적으로 부당해고·권고사직 유도했다면 → 대법 2010다100629 등 청구 가능

## ✅ 권장 조치
1. 취업규칙·근로계약서 즉시 확인
2. 퇴직 사유가 사용자 권유·압박이라면 녹취·문자 증거 보존`,
    gpt: `## 📌 결론
주 6일 + 11개월 → 퇴직금 법정 수급권 없음 (근퇴법 제4조).

## 🧮 계산 시뮬레이션
1년을 채웠다면:
- 평균임금 = 직전 3개월 임금총액 / 3개월 총일수
- 예) 월급 250만, 90일 → 평균임금 83,333원/일
- 퇴직금 = 83,333 × 30 × (365/365) = **약 250만원**

## 📊 실무 포인트
- 회사가 "1년 채우지 말라" 권유 → 위법
- 11개월 + 2주 휴가로 1년 채우는 방법 검토
- 평균임금 산입: ○ 기본급, 상여금, 고정OT, 식대  × 일시적 지급금`,
    final: `## 📌 결론
주 15시간 이상 근무했더라도 **계속근로기간 11개월**이면 법정 퇴직금 청구권은 발생하지 않습니다 (근로자퇴직급여보장법 제4조).

다만 다음 경우 청구 가능:
- 취업규칙·근로계약서에 더 유리한 조항이 있는 경우
- 사용자가 1년 도래 직전 부당해고·권고사직을 유도한 경우 (대법 2010다100629)

## 📖 법령 근거
- **근로자퇴직급여보장법 제4조**: 1년 이상 + 주 15시간 이상
- **동법 제8조**: 퇴직금 산정공식
- **근로기준법 제2조 제6호**: 평균임금

## 🔍 사안 분석 + 계산
- 입사일·퇴직일 정확히 확인 (1년 = 입사일 + 365일)
- 가정: 월급 250만원 → 1년 채웠다면 퇴직금 약 250만원
- 따라서 단 며칠 차이로 큰 금액 차이 발생

## ✅ 권장 조치
1. **단기 (오늘)**: 근로계약서·취업규칙·최근 3개월 급여명세서 확보
2. **중기 (1주 내)**: 퇴직 사유 검토 - 본인 자발 vs 회사 권유
3. **퇴직 권유 정황 있다면**: 카톡·문자·녹취 보존 → 노무사 자문
4. **취업규칙에 별도 규정**: 해당 조항 근거 청구

## 📂 필요 서식·증거
- 근로계약서, 취업규칙 사본
- 최근 3개월 급여명세서 + 통장거래내역
- 퇴직 권유 정황 증거 (카톡/문자/녹취)

## ⚠️ 주의사항
- 1년 임박 자발 퇴사는 청구권 없음
- 단, 회사가 1년을 못 채우게 의도적 방해는 다름
- 임금채권 시효 3년 적용

💡 **RAG 참고**: 카톡에서 추출된 노무사 답변에서 강조된 "평균임금 산정 직전 3개월 + 미사용 연차수당 3/12 산입" 원칙도 확인됨.`,
    tokens: 3680,
  },
  annual_leave: {
    gpt: `## 📌 결론
1년 미만 근속자 연차: 1개월 개근시 1일씩, 최대 11일 (근로기준법 제60조 제2항).

## 🧮 연차 발생 시뮬레이션 (입사 2025-01-01 기준)
| 시점 | 발생 | 누적 |
|------|------|------|
| 2025-02-01 | +1일 | 1일 |
| 2025-03-01 | +1일 | 2일 |
| ... | ... | ... |
| 2025-12-01 | +1일 | 11일 |
| 2026-01-01 (만 1년) | +15일 | 26일 |
| 2027-01-01 (만 2년) | +15일 | 41일 |
| 2028-01-01 (만 3년, 가산) | +16일 | 57일 |

## 📅 사용 기한
- 1년 미만 발생분: 입사일로부터 1년 내
- 1년 이상 발생분: 발생일로부터 1년 내
- 연차촉진제도 적용시 사용촉진 → 수당 청구권 소멸

## ✅ 권장 조치
1. 본인 입사일·근속기간 확인
2. 회계연도(1/1~12/31) 기준 부여시 입사일 기준보다 불리하지 않은지 비교
3. 연차 사용 신청은 가능한 한 서면(메일)으로

## ⚠️ 주의사항
- 5인 미만 사업장은 연차 규정 적용 제외
- 결근일이 있는 달은 연차 미발생
- 연차수당 = 통상임금 × 미사용일수, 시효 3년

💡 **RAG 참고**: 카톡 노무사 답변에서 "결근 1회당 해당 월 연차 미발생" 원칙 확인됨. 연차촉진은 6개월 전·2개월 전 2차에 걸쳐 시기·방식 요건 충족해야 유효.`,
    tokens: 980,
  },
  harassment: {
    claude: `먼저, 매일 욕설을 들으며 출근하시는 상황 자체가 정상이 아닙니다. 참아야 할 일이 아니고 법으로 보호받을 수 있는 명백한 사안입니다.

## 📌 결론
팀장의 욕설은 근로기준법 제76조의2(직장 내 괴롭힘) 위반에 해당할 가능성이 매우 높으며, 회사 신고 → 조사·징계 의무 발생 → 미조치시 노동청 진정 + 손해배상 청구 가능.

## 📖 법령 근거
- **근로기준법 제76조의2**: 직장에서의 지위·관계 우위를 이용하여 업무상 적정범위를 넘는 신체적·정신적 고통을 주는 행위 금지
- **제76조의3**: 신고 접수시 회사는 ① 지체없이 조사 ② 피해자 의사 반영 보호조치 ③ 가해자 징계 ④ 보복금지 의무
- 위반시 회사 1년 이하 징역 또는 1천만원 이하 벌금

## 🔍 증거 수집 (최우선)
- 일시·장소·발언내용 메모 (매일 기록)
- 통화·대면 녹음 (한국은 통화 당사자 녹음 합법, 통신비밀보호법 제3조)
- 카톡·문자 캡처
- 목격자 진술 확보
- 정신건강의학과 진료기록 (산재·손해배상 입증자료)

## ✅ 권장 조치
1. **단기 (이번 주)**: 증거 수집 시작 + 인사팀·대표에게 **서면(이메일)** 신고
2. **중기 (2주 내)**: 회사 조사 결과 통보 요구. 미흡하면 고용노동부 진정
3. **장기**: 보복성 인사발령·따돌림 발생시 추가 진정 + 민사 손해배상 (위자료 300~1,000만원 판례 다수)

## 🏥 산재 신청 가능성
- 욕설로 인한 적응장애·우울증 진단시 산업재해 인정 가능
- 근로복지공단에 직접 신청 (회사 동의 불필요)

## ⚠️ 주의사항
- 신고 후 회사가 가해자 편 들 가능성 대비 → 외부 증거를 먼저 확보
- 신고 이유 불이익은 별도 형사처벌 대상
- 5인 미만 사업장도 직장내괴롭힘 규정 적용 (2021년 개정)

힘드시겠지만 혼자 견디지 마시고, 가능한 한 빨리 증거 수집부터 시작하세요.

💡 **RAG 참고**: 카톡 노무사가 강조한 "통화 당사자 녹음은 합법, 카톡 캡처는 즉시 클라우드 백업" 실무 팁이 반영됨.`,
    tokens: 2150,
  },
};

const _genericAnswer = (cat) => {
  const text = `## 📌 결론
${cat.n} 관련 ${cat.r} 엔진 응답입니다.

## 📖 법령 근거
- 관련 조문 자동 인용

## ✅ 권장 조치
1. 단기 / 2. 중기 / 3. 장기 조치

## 📂 필요 서식·증거
- 준비 서류 목록

## ⚠️ 주의사항
- 시효·기한 확인

---
💡 데모: 실제 운영시 ${cat.r === "DUAL" ? "Claude + GPT 통합" : cat.r} 응답이 1,000~3,000자로 표시됩니다. 풍부한 응답은 해고/퇴직금/연차/괴롭힘 카테고리에서 확인하세요.`;
  return { claude: text, gpt: text, final: text, tokens: 1200 };
};

// ─── 자문 호출. 실제 백엔드 연동시 fetch(server/api/consult) 로 교체. ───
async function fetchAdvice({ category, router, question }) {
  // 시뮬: DUAL은 약간 더 길게
  const delay = router === "DUAL" ? 2200 : 1500;
  await new Promise(r => setTimeout(r, delay));
  const mock = MOCK_ANSWERS[category.k] || _genericAnswer(category);
  const rag = RAG_SAMPLES[category.k] || [];
  return { mock, rag };
}

const ROUTER_COLORS = { CLAUDE: "#ff7849", GPT: "#10a37f", DUAL: "#6c5ce7" };

/* ─── 인포그래픽 요약 파서 ───
   LLM 답변(마크다운)에서 핵심 정보를 추출해 카드용 데이터로 변환.
   상정한 섹션 마커: ## 📌 결론 / ## 📖 법령 근거 / ## ✅ 권장 조치 /
                     ## 📂 필요 서식 / ## ⚠️ 주의사항 / ## 🧮 계산 / ## 🔍 사안 분석 */
function extractInfographic(text, category) {
  if (!text || typeof text !== "string") return null;
  const sections = {};
  // ## 헤더(이모지 포함)로 split
  const lines = text.split(/\n/);
  let currentKey = null;
  let buf = [];
  const flush = () => { if (currentKey) sections[currentKey] = (sections[currentKey] || "") + buf.join("\n").trim(); buf = []; };
  for (const line of lines) {
    const m = line.match(/^##\s*(.+)$/);
    if (m) {
      flush();
      const h = m[1].trim();
      if (/결론/.test(h)) currentKey = "conclusion";
      else if (/법령|근거/.test(h)) currentKey = "laws";
      else if (/사안|분석/.test(h) && !/계산/.test(h)) currentKey = "analysis";
      else if (/계산|시뮬레이션|금액/.test(h)) currentKey = "calc";
      else if (/권장|조치|단기|중기|장기/.test(h)) currentKey = "actions";
      else if (/필요|서식|증거/.test(h)) currentKey = "evidence";
      else if (/주의|시효|기한/.test(h)) currentKey = "caution";
      else currentKey = "other";
    } else {
      buf.push(line);
    }
  }
  flush();
  // 결론 한 줄 — 첫 비어있지 않은 줄
  const conclusionLine = (sections.conclusion || "").split(/\n/).map(s => s.trim()).filter(Boolean)[0] || "";
  // 법령 → 굵게 표시된 조문 추출
  const laws = [];
  const lawText = sections.laws || "";
  const lawMatches = [...lawText.matchAll(/\*\*([^*]+법[^*]*제\s*\d+조[^*]*)\*\*/g)];
  for (const m of lawMatches) laws.push(m[1].replace(/\s+/g, " ").trim());
  if (laws.length === 0) {
    // 굵은표기 없으면 - 로 시작하는 줄에서 법률명 추출
    for (const line of lawText.split(/\n/)) {
      const lm = line.match(/(?:^|\s)([가-힣\w]+법[^:,\n]*제\s*\d+조[^:,\n]*)/);
      if (lm) laws.push(lm[1].trim());
      if (laws.length >= 3) break;
    }
  }
  // 권장 조치 — 단기/중기/장기 키워드로 분리
  const actions = { 단기: "", 중기: "", 장기: "" };
  const actText = sections.actions || "";
  for (const line of actText.split(/\n/)) {
    const sm = line.match(/단기[^)]*\)?[:\s]+(.+)$/);
    const mm = line.match(/중기[^)]*\)?[:\s]+(.+)$/);
    const lm = line.match(/장기[^)]*\)?[:\s]+(.+)$/);
    if (sm && !actions.단기) actions.단기 = sm[1].replace(/\*+/g, "").trim().slice(0, 80);
    if (mm && !actions.중기) actions.중기 = mm[1].replace(/\*+/g, "").trim().slice(0, 80);
    if (lm && !actions.장기) actions.장기 = lm[1].replace(/\*+/g, "").trim().slice(0, 80);
  }
  // 단기/중기/장기 라벨 없으면 번호 매긴 1./2./3. 으로 폴백
  if (!actions.단기 && !actions.중기 && !actions.장기) {
    const nums = [...actText.matchAll(/^\s*(\d)\.\s*\*?\*?([^*\n]+)\*?\*?/gm)];
    if (nums.length > 0) {
      const slots = ["단기", "중기", "장기"];
      nums.slice(0, 3).forEach((m, i) => { actions[slots[i]] = m[2].trim().slice(0, 80); });
    }
  }
  // 금액 추출 — 첫 등장한 ₩/만원/억원 단위 숫자
  const allText = text;
  const moneyMatch = allText.match(/(\d{1,3}(?:,\d{3})*만원|\d+(?:\.\d+)?\s*억원|약\s*\d+(?:,\d+)*\s*원|\d{1,3}(?:,\d{3})+\s*원)/);
  const money = moneyMatch ? moneyMatch[1] : "";
  // 시효 추출
  const limitMatch = allText.match(/시효[^.]{0,40}?(\d+\s*년)/);
  const limit = limitMatch ? limitMatch[1] : "";
  // 기한 추출 (제척기간/구제신청 기한)
  const deadlineMatch = allText.match(/(?:제척기간|구제신청|기한)[^.]{0,30}?(\d+\s*[개월년일])/);
  const deadline = deadlineMatch ? deadlineMatch[1] : "";
  // 위험도/긴급도 추정
  let riskLevel = "보통", riskColor = "#10a37f";
  if (/긴급|급박|즉시|당장|3개월|14일|제척기간/.test(text)) { riskLevel = "긴급"; riskColor = "#dc2626"; }
  else if (/주의|위험|중요|반드시/.test(text)) { riskLevel = "주의"; riskColor = "#f59e0b"; }
  // 청구 가능 여부 추정
  let claimable = null;
  if (/청구권\s*(없음|발생하지)/.test(text) || /수급권\s*없음/.test(text)) claimable = "불가";
  else if (/청구\s*가능|받을\s*수\s*있/.test(text)) claimable = "가능";
  // 헤드라인 — 카테고리 + 결론 첫 문장
  const headline = conclusionLine.replace(/[*#]/g, "").trim();

  return {
    category,
    headline: headline || `${category.n} 관련 분석`,
    laws: laws.slice(0, 3),
    actions,
    money,
    limit,
    deadline,
    riskLevel, riskColor,
    claimable,
    hasContent: !!(headline || laws.length || actions.단기 || money),
  };
}

function InfographicSummary({ data }) {
  if (!data || !data.hasContent) return null;
  const { category, headline, laws, actions, money, limit, deadline, riskLevel, riskColor, claimable } = data;
  const T = {
    cream:"#0f172a", paper:"#1e293b", line:"#334155", ink:"#f1f5f9",
    silk:"#c9a96e", silkD:"#a8864a", silkL:"#e8d5a3",
    leaf:"#86efac", muted:"#94a3b8",
  };
  const claimColor = claimable === "가능" ? "#10b981" : claimable === "불가" ? "#dc2626" : "#94a3b8";
  return (
    <div style={{
      marginBottom: 14, borderRadius: 10, overflow: "hidden",
      border: `2px solid ${category.c}`,
      background: `linear-gradient(135deg, ${category.c}15, ${category.c}05)`,
      boxShadow: `0 4px 14px ${category.c}30`,
    }}>
      {/* 신문 헤드라인 — 카테고리 배지 + 위험도 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 8px",
        borderBottom: `1px dashed ${category.c}66`,
        background: `linear-gradient(90deg, ${category.c}25, transparent)`,
      }}>
        <div style={{ fontSize: 22 }}>{category.i}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: category.c, textTransform: "uppercase" }}>
            {category.n} · 한눈에 보기
          </div>
          <div style={{ fontSize: 14, fontWeight: 900, color: T.ink, lineHeight: 1.35, marginTop: 2, fontFamily: '"Noto Serif KR","Nanum Myeongjo",serif' }}>
            {headline}
          </div>
        </div>
        <div style={{
          padding: "4px 10px", borderRadius: 6, background: riskColor, color: "#fff",
          fontSize: 10, fontWeight: 900, letterSpacing: 1, textAlign: "center", minWidth: 50,
        }}>
          {riskLevel}
        </div>
      </div>

      {/* 인포그래픽 그리드 — 4 칸 */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1,
        background: T.line,
      }}>
        {/* 청구 가능 여부 / 핵심 금액 */}
        <InfoCell label="청구 가능" value={claimable || "검토 필요"} valueColor={claimColor} icon="⚖️" />
        <InfoCell label="핵심 금액" value={money || "—"} valueColor={money ? T.silkL : T.muted} icon="💰" />
        <InfoCell label="시효" value={limit || "—"} valueColor={limit ? "#fbbf24" : T.muted} icon="⏳" />
        <InfoCell label="기한" value={deadline || "—"} valueColor={deadline ? "#fca5a5" : T.muted} icon="📅" />
      </div>

      {/* 핵심 법령 (3개 한 줄) */}
      {laws.length > 0 && (
        <div style={{ padding: "10px 14px", borderBottom: `1px dashed ${category.c}33`, background: T.paper }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: category.c, marginBottom: 5, letterSpacing: 1 }}>📖 핵심 법령</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {laws.map((law, i) => (
              <span key={i} style={{
                fontSize: 11, padding: "3px 9px", background: `${category.c}22`, color: T.ink,
                borderRadius: 4, fontWeight: 600, border: `1px solid ${category.c}55`,
              }}>
                {law}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 권장 조치 — 단기/중기/장기 타임라인 */}
      {(actions.단기 || actions.중기 || actions.장기) && (
        <div style={{ padding: "10px 14px", background: T.paper }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: category.c, marginBottom: 7, letterSpacing: 1 }}>✅ 권장 조치 타임라인</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { k: "단기", emoji: "🔥", color: "#dc2626", label: "단기 (오늘~)" },
              { k: "중기", emoji: "📋", color: "#f59e0b", label: "중기 (1~2주)" },
              { k: "장기", emoji: "🏛️", color: "#3b82f6", label: "장기 (1개월+)" },
            ].map(step => (
              <div key={step.k} style={{
                padding: 8, background: T.cream, borderRadius: 5,
                borderTop: `3px solid ${actions[step.k] ? step.color : T.line}`,
                opacity: actions[step.k] ? 1 : 0.4,
              }}>
                <div style={{ fontSize: 9, color: step.color, fontWeight: 700, marginBottom: 3 }}>
                  {step.emoji} {step.label}
                </div>
                <div style={{ fontSize: 10, color: T.ink, lineHeight: 1.5 }}>
                  {actions[step.k] || "(없음)"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 신문 푸터 — 작성 timestamp */}
      <div style={{
        padding: "5px 14px", background: T.cream, fontSize: 8, color: T.muted, textAlign: "right",
        fontFamily: '"Noto Serif KR",serif', letterSpacing: 1,
      }}>
        AI 자동 분석 · {new Date().toLocaleString("ko-KR", { hour12: false })}
      </div>
    </div>
  );
}

function InfoCell({ label, value, valueColor, icon }) {
  return (
    <div style={{
      padding: "10px 8px", background: "#1e293b", textAlign: "center",
    }}>
      <div style={{ fontSize: 13, marginBottom: 2 }}>{icon}</div>
      <div style={{ fontSize: 8, color: "#94a3b8", marginBottom: 3, fontWeight: 700, letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 900, color: valueColor || "#f1f5f9", lineHeight: 1.2, fontFamily: '"Noto Serif KR",serif' }}>
        {value}
      </div>
    </div>
  );
}

export default function LaborAdvisorModule({ T, fontFamily, sansFamily }) {
  const [current, setCurrent] = useState(LABOR_CATEGORIES[0]);
  const [question, setQuestion] = useState("");
  const [routerOverride, setRouterOverride] = useState(""); // "", CLAUDE, GPT, DUAL
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState("");

  const effectiveRouter = routerOverride || current.r;

  const run = async () => {
    const q = question.trim();
    if (!q) { alert("질문을 입력해주세요."); return; }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetchAdvice({ category: current, router: effectiveRouter, question: q });
      const r = { cat: current, router: effectiveRouter, question: q, mock: res.mock, rag: res.rag };
      setResult(r);
      // 기본 활성 탭 선택
      if (effectiveRouter === "DUAL") setActiveTab(res.mock.final ? "fn" : (res.mock.claude ? "cl" : "gp"));
      else if (effectiveRouter === "CLAUDE") setActiveTab("cl");
      else setActiveTab("gp");
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (e) => { if (e.ctrlKey && e.key === "Enter") run(); };

  const tabs = useMemo(() => {
    if (!result) return [];
    const arr = [];
    if (result.router === "DUAL") {
      if (result.mock.final) arr.push({ k: "fn", l: "🎯 통합", f: "final", c: ROUTER_COLORS.DUAL });
      if (result.mock.claude) arr.push({ k: "cl", l: "🟠 Claude", f: "claude", c: ROUTER_COLORS.CLAUDE });
      if (result.mock.gpt) arr.push({ k: "gp", l: "🟢 GPT", f: "gpt", c: ROUTER_COLORS.GPT });
    } else if (result.router === "CLAUDE") {
      arr.push({ k: "cl", l: "🟠 Claude 답변", f: "claude", c: ROUTER_COLORS.CLAUDE });
    } else {
      arr.push({ k: "gp", l: "🟢 GPT 답변", f: "gpt", c: ROUTER_COLORS.GPT });
    }
    return arr;
  }, [result]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 14 }}>
      {/* ─── 좌측: 11개 카테고리 ─── */}
      <div style={{ background: T.paper, borderRadius: 8, padding: 12, border: `1px solid ${T.line}`, alignSelf: "start" }}>
        <h3 style={{ fontSize: 12, color: T.silkL, marginBottom: 10, fontFamily: fontFamily, paddingBottom: 6, borderBottom: `1px solid ${T.line}` }}>
          📋 상담 유형 (11종)
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {LABOR_CATEGORIES.map(cat => {
            const active = cat.k === current.k;
            return (
              <div key={cat.k}
                onClick={() => { setCurrent(cat); setResult(null); setRouterOverride(""); }}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 9px", background: active ? T.cream : "transparent",
                  borderRadius: 5, cursor: "pointer", fontSize: 12, userSelect: "none",
                  border: `2px solid ${active ? cat.c : "transparent"}`,
                  transition: "all 0.15s",
                }}>
                <span style={{ fontSize: 14 }}>{cat.i}</span>
                <span style={{ flex: 1, fontWeight: 600, color: T.ink, fontSize: 11 }}>{cat.n}</span>
                {cat.rag > 0 && (
                  <span style={{ fontSize: 9, padding: "1px 5px", background: ROUTER_COLORS.DUAL, color: "#fff", borderRadius: 7, fontWeight: 700 }}>
                    {cat.rag}
                  </span>
                )}
                <span style={{ fontSize: 9, padding: "1px 5px", background: ROUTER_COLORS[cat.r], color: "#fff", borderRadius: 3, fontWeight: 700 }}>
                  {cat.r}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── 우측: 선택 카테고리 + 입력 + 결과 ─── */}
      <div style={{ background: T.paper, borderRadius: 8, padding: 14, border: `1px solid ${T.line}` }}>
        {/* 선택 카테고리 박스 */}
        <div style={{
          padding: "10px 12px", background: T.cream, borderRadius: 6, marginBottom: 12,
          borderLeft: `4px solid ${current.c}`,
        }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, fontFamily: fontFamily }}>
            {current.i} {current.n}
            <span style={{ fontSize: 9, padding: "1px 5px", marginLeft: 6, background: ROUTER_COLORS[current.r], color: "#fff", borderRadius: 3, fontWeight: 700 }}>
              {current.r}
            </span>
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{current.d}</div>
          <div style={{ fontSize: 11, color: ROUTER_COLORS.DUAL, fontWeight: 600, marginTop: 5 }}>
            {current.rag > 0
              ? `📚 이 카테고리에 카톡 실제 사례 ${current.rag}건이 RAG로 참고됩니다`
              : `📚 등록된 실제 사례 없음 (LLM 자체 지식으로만 답변)`}
          </div>
          <div style={{ marginTop: 8 }}>
            {current.ec.map(ex => (
              <span key={ex}
                onClick={() => setQuestion(ex)}
                style={{
                  display: "inline-block", padding: "3px 9px", margin: "2px 3px 2px 0",
                  background: T.paper, border: `1px solid ${T.line}`, borderRadius: 11,
                  fontSize: 11, cursor: "pointer", color: T.ink, userSelect: "none",
                }}>
                {ex}
              </span>
            ))}
          </div>
        </div>

        {/* 입력 */}
        <textarea value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={onKeyDown}
          placeholder="질문을 입력하거나 위 예시 칩을 클릭하세요. (Ctrl+Enter로 즉시 전송)"
          style={{
            width: "100%", minHeight: 80, padding: 10, fontSize: 12, fontFamily: sansFamily,
            background: T.cream, color: T.ink, border: `2px solid ${T.line}`, borderRadius: 6,
            resize: "vertical", outline: "none",
          }} />
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap", fontSize: 11, color: T.muted }}>
          <label>엔진:</label>
          <select value={routerOverride} onChange={e => setRouterOverride(e.target.value)}
            style={{ padding: "5px 8px", background: T.cream, color: T.ink, border: `1px solid ${T.line}`, borderRadius: 4, fontSize: 11 }}>
            <option value="">자동 ({current.r})</option>
            <option value="CLAUDE">Claude</option>
            <option value="GPT">GPT</option>
            <option value="DUAL">DUAL (둘 다 호출 후 통합)</option>
          </select>
          <button onClick={run} disabled={loading}
            style={{
              padding: "7px 16px", background: loading ? "#7f8c8d" : `linear-gradient(135deg,${T.silk},${T.silkD})`,
              color: "#fff", border: "none", borderRadius: 4, fontSize: 12, fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
            }}>
            {loading ? "⏳ 처리중..." : "🚀 상담 요청"}
          </button>
          <span style={{ color: T.muted, fontSize: 10 }}>Ctrl+Enter</span>
        </div>

        {/* 로딩 / 결과 */}
        {loading && (
          <div style={{ padding: 20, textAlign: "center", color: T.muted, fontSize: 12 }}>
            <div style={{
              display: "inline-block", width: 22, height: 22, border: `3px solid ${T.line}`,
              borderTopColor: T.silk, borderRadius: "50%", animation: "labor-spin 0.8s linear infinite",
              marginBottom: 6,
            }} />
            <div>RAG 사례 검색 + {effectiveRouter === "DUAL" ? "Claude+GPT 동시" : effectiveRouter} 호출 중...</div>
            <style>{`@keyframes labor-spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {result && !loading && (() => {
          // 인포그래픽용 답변 텍스트 선택 — DUAL이면 final, CLAUDE면 claude, GPT면 gpt
          const fullText = result.mock.final || result.mock.claude || result.mock.gpt || "";
          const infoData = extractInfographic(fullText, result.cat);
          return (
          <div style={{ marginTop: 14 }}>
            {/* ⭐ 신문 헤드라인 스타일 인포그래픽 — 모든 분석 결과 최상단 */}
            {infoData && <InfographicSummary data={infoData} />}

            <div style={{ display: "flex", gap: 5, marginBottom: 10, flexWrap: "wrap" }}>
              <span style={{ padding: "3px 8px", borderRadius: 10, background: T.cream, fontSize: 10, fontWeight: 600, color: T.ink }}>
                {result.cat.i} {result.cat.n}
              </span>
              <span style={{ padding: "3px 8px", borderRadius: 10, background: ROUTER_COLORS[result.router], color: "#fff", fontSize: 10, fontWeight: 700 }}>
                {result.router}
              </span>
              <span style={{ padding: "3px 8px", borderRadius: 10, background: T.cream, fontSize: 10, fontWeight: 600, color: T.ink }}>
                🪙 {(result.mock.tokens || 0).toLocaleString()} tokens
              </span>
              {result.rag.length > 0 && (
                <span style={{ padding: "3px 8px", borderRadius: 10, background: ROUTER_COLORS.DUAL, color: "#fff", fontSize: 10, fontWeight: 700 }}>
                  📚 RAG 사례 {result.rag.length}건 참조
                </span>
              )}
            </div>

            {tabs.length > 1 && (
              <div style={{ display: "flex", gap: 2, borderBottom: `2px solid ${T.line}`, marginBottom: 10, flexWrap: "wrap" }}>
                {tabs.map(t => (
                  <div key={t.k} onClick={() => setActiveTab(t.k)}
                    style={{
                      padding: "7px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600,
                      color: activeTab === t.k ? T.ink : T.muted,
                      borderBottom: `2px solid ${activeTab === t.k ? t.c : "transparent"}`,
                      marginBottom: -2, userSelect: "none",
                    }}>
                    {t.l}
                  </div>
                ))}
              </div>
            )}
            {tabs.map(t => (
              <div key={t.k} style={{
                display: activeTab === t.k ? "block" : "none",
                background: T.cream, padding: "14px 16px", borderRadius: 5,
                borderLeft: `4px solid ${t.c}`, fontSize: 12, lineHeight: 1.75,
                whiteSpace: "pre-wrap", wordWrap: "break-word", color: T.ink,
                fontFamily: sansFamily,
              }}>
                {result.mock[t.f] || "응답 없음"}
              </div>
            ))}

            {result.rag.length > 0 && (
              <div style={{ background: "#1a1729", borderRadius: 6, padding: 12, marginTop: 10, border: `1px solid ${T.line}` }}>
                <h3 style={{ fontSize: 12, color: ROUTER_COLORS.DUAL, marginBottom: 7, fontFamily: fontFamily }}>
                  📚 LLM이 참고한 카톡 상담방 실제 사례 ({result.rag.length}건)
                </h3>
                {result.rag.map((c, i) => (
                  <div key={i} style={{
                    background: T.paper, padding: "7px 10px", borderRadius: 4, marginBottom: 5,
                    fontSize: 10, lineHeight: 1.6,
                  }}>
                    <div style={{ color: ROUTER_COLORS.DUAL, fontWeight: 700 }}>
                      사례 {i + 1} · {c.expert}
                    </div>
                    <div style={{ color: T.ink, margin: "2px 0" }}>Q. {c.q}</div>
                    <div style={{ color: T.muted }}>A. {c.a}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          );
        })()}

        {!loading && !result && (
          <div style={{
            marginTop: 18, padding: "10px 14px", background: "#fff3cd33", color: "#ffc107",
            borderRadius: 6, fontSize: 11, borderLeft: "4px solid #ffc107",
          }}>
            💡 좌측에서 유형 선택 → 예시 칩 클릭 → 상담 요청. <strong>해고/퇴직금/연차/괴롭힘</strong> 4개 카테고리는 풍부한 응답과 RAG 사례를 함께 보여줍니다.
            실제 LLM 연동시 <code>fetchAdvice()</code> 를 백엔드(<code>/api/consult</code>)로 교체하면 동일 UI에 진짜 Claude/GPT 응답이 들어옵니다.
          </div>
        )}
      </div>
    </div>
  );
}
